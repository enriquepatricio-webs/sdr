/**
 * Cliente de Composio para Google Calendar.
 *
 * Contrato verificado: POST https://backend.composio.dev/api/v3/tools/execute/{slug}
 * con cabecera `x-api-key` y cuerpo { arguments, connected_account_id?, user_id?, version }.
 *
 * La parte interesante de este fichero no es la llamada HTTP: es `calcularHuecos`,
 * que convierte los huecos libres del calendario en huecos PROPONIBLES según las
 * reglas del playbook. Es una función pura y está probada aparte, porque de ella
 * depende que el agente no proponga una reunión dentro de una hora, ni un
 * domingo, ni pegada a otra sin respirar.
 */
import type { BookingRules } from "./db/schema";
import { instanteLocal, partesLocales } from "./sending-window";

const BASE = "https://backend.composio.dev/api/v3";

export const HERRAMIENTAS = {
  buscarHuecos: "GOOGLECALENDAR_FIND_FREE_SLOTS",
  crearEvento: "GOOGLECALENDAR_CREATE_EVENT",
} as const;

export class ComposioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ComposioError";
  }
}

function apiKey(): string {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error("COMPOSIO_API_KEY no está definida.");
  return key;
}

export type RespuestaComposio<T> = {
  successful?: boolean;
  successfull?: boolean;
  data?: T;
  error?: string | null;
};

export type ConexionComposio = {
  id: string;
  user_id?: string;
  status?: string;
  toolkit?: { slug?: string };
};

/**
 * Las cuentas conectadas en Composio.
 *
 * Con una sola, Composio resolvía sola cuál usar. Con más de una responde 400
 * pidiendo un `user_id`, y sin poder listarlas no hay forma de saber cuál pedir
 * sin sacar la clave de producción, que es sensible y no se puede releer.
 */
export async function listarConexiones(): Promise<ConexionComposio[]> {
  const res = await fetch(`${BASE}/connected_accounts?limit=50`, {
    headers: { "x-api-key": apiKey() },
    cache: "no-store",
  });
  const texto = await res.text();
  if (!res.ok) {
    throw new ComposioError(
      `Composio respondió ${res.status}: ${texto.slice(0, 300)}`,
      res.status,
      texto,
    );
  }
  const json = JSON.parse(texto) as { items?: ConexionComposio[] };
  return json.items ?? [];
}

/**
 * La conexión de Google Calendar que se puede usar ahora mismo.
 *
 * No se fija a mano en un ajuste porque las conexiones caducan y se rehacen: en
 * esta cuenta hay cuatro de Google Calendar y dos ya están caducadas. Un id
 * escrito a fuego funcionaría hasta la primera reconexión y luego fallaría con
 * un error que no dice nada. Preguntando cuál está viva, reconectar en Composio
 * arregla el calendario sin tocar código.
 *
 * Cuesta una llamada extra por consulta de agenda, que son unas pocas por
 * conversación.
 * ponytail: sin caché; si algún día pesa, se guarda con un TTL corto.
 */
export async function cuentaDeCalendario(): Promise<string> {
  const conexiones = await listarConexiones();
  const viva = conexiones.find(
    (c) => c.toolkit?.slug === "googlecalendar" && c.status === "ACTIVE",
  );
  if (!viva) {
    const cuantas = conexiones.filter(
      (c) => c.toolkit?.slug === "googlecalendar",
    ).length;
    throw new ComposioError(
      cuantas > 0
        ? `Hay ${cuantas} conexiones de Google Calendar en Composio y ninguna activa: están caducadas. Vuelve a conectarla en Composio.`
        : "No hay ninguna conexión de Google Calendar en Composio.",
      409,
      "",
    );
  }
  return viva.id;
}

/**
 * Ejecuta una herramienta.
 *
 * `version` se manda siempre: Composio exige versión explícita del toolkit para
 * que la llamada resuelva a una definición conocida y no cambie bajo los pies.
 */
export async function ejecutar<T>(
  slug: string,
  argumentos: Record<string, unknown>,
  opciones: {
    userId?: string;
    connectedAccountId?: string;
    version?: string;
  } = {},
): Promise<T> {
  const res = await fetch(`${BASE}/tools/execute/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({
      arguments: argumentos,
      version: opciones.version ?? "latest",
      ...(opciones.userId ? { user_id: opciones.userId } : {}),
      ...(opciones.connectedAccountId
        ? { connected_account_id: opciones.connectedAccountId }
        : {}),
    }),
    cache: "no-store",
  });

  const texto = await res.text();
  if (!res.ok) {
    throw new ComposioError(
      `Composio respondió ${res.status}: ${texto.slice(0, 300)}`,
      res.status,
      texto,
    );
  }

  let json: RespuestaComposio<T>;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new ComposioError(
      "Composio devolvió algo que no es JSON",
      res.status,
      texto,
    );
  }

  // Un 200 con successful:false es un fallo de la herramienta, no de HTTP.
  const fueBien = json.successful ?? json.successfull ?? true;
  if (!fueBien) {
    throw new ComposioError(
      `La herramienta ${slug} falló: ${json.error ?? "sin detalle"}`,
      res.status,
      texto,
    );
  }

  return json.data as T;
}

/* -------------------------------------------------------------------------- */
/* Cálculo de huecos proponibles                                               */
/* -------------------------------------------------------------------------- */

export type Intervalo = { inicio: Date; fin: Date };

const PASO_MINUTOS = 30;

/**
 * Convierte el calendario en huecos que se pueden proponer sin mentir.
 *
 * Aplica, en este orden:
 *   · antelación mínima  — nada dentro de las próximas N horas
 *   · días y horario     — en la zona del prospecto, no en la del servidor
 *   · colchón            — ni pegado a lo que ya hay antes ni a lo de después
 *   · reparto            — como mucho uno por día
 *
 * Lo del reparto es criterio de ventas, no técnico: ofrecer "martes a las 10:00
 * o jueves a las 16:00" cierra mejor que "10:00, 10:30 u 11:00", que además deja
 * en evidencia que tienes la agenda vacía.
 */
export function calcularHuecos(
  ocupado: Intervalo[],
  reglas: BookingRules,
  ahora: Date = new Date(),
): Intervalo[] {
  const {
    timezone,
    duration_min,
    min_notice_hours,
    buffer_min,
    lookahead_days,
    working_hours,
  } = reglas;

  const desde = new Date(ahora.getTime() + min_notice_hours * 3600_000);

  // Cada evento ocupado se ensancha con el colchón por los dos lados.
  const bloqueado = ocupado.map((o) => ({
    inicio: new Date(o.inicio.getTime() - buffer_min * 60_000),
    fin: new Date(o.fin.getTime() + buffer_min * 60_000),
  }));

  const libre = (inicio: Date, fin: Date) =>
    !bloqueado.some((b) => inicio < b.fin && fin > b.inicio);

  const huecos: Intervalo[] = [];
  const hoy = partesLocales(timezone, ahora).fecha;

  for (
    let salto = 0;
    salto <= lookahead_days && huecos.length < reglas.max_slots_offered;
    salto++
  ) {
    const dia = new Date(`${hoy}T00:00:00Z`);
    dia.setUTCDate(dia.getUTCDate() + salto);
    const fecha = dia.toISOString().slice(0, 10);
    const dow = dia.getUTCDay() === 0 ? 7 : dia.getUTCDay();
    if (!working_hours.days.includes(dow)) continue;

    const abre = instanteLocal(timezone, fecha, working_hours.from);
    const cierra = instanteLocal(timezone, fecha, working_hours.to);

    for (
      let t = abre.getTime();
      t + duration_min * 60_000 <= cierra.getTime();
      t += PASO_MINUTOS * 60_000
    ) {
      const inicio = new Date(t);
      const fin = new Date(t + duration_min * 60_000);
      if (inicio < desde) continue;
      if (!libre(inicio, fin)) continue;

      huecos.push({ inicio, fin });
      break; // uno por día y a por el siguiente
    }
  }

  return huecos.slice(0, reglas.max_slots_offered);
}

/* -------------------------------------------------------------------------- */
/* Herramientas del agente                                                     */
/* -------------------------------------------------------------------------- */

type RespuestaHuecos = {
  // La forma exacta varía entre versiones del toolkit, así que se aceptan
  // varios nombres en vez de reventar si Composio renombra un campo.
  busy?: Record<string, { busy?: { start: string; end: string }[] }>;
  calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
};

function extraerOcupado(data: RespuestaHuecos): Intervalo[] {
  const calendarios = data.calendars ?? data.busy ?? {};
  return Object.values(calendarios)
    .flatMap((c) => c?.busy ?? [])
    .map((b) => ({ inicio: new Date(b.start), fin: new Date(b.end) }))
    .filter(
      (i) =>
        !Number.isNaN(i.inicio.getTime()) && !Number.isNaN(i.fin.getTime()),
    );
}

/**
 * Huecos reales, consultados al calendario.
 *
 * Si Composio falla, esto LANZA. No devuelve una lista vacía ni una por
 * defecto: el agente tiene que poder distinguir "no tengo hueco" de "no he
 * podido mirar", porque en el segundo caso su instrucción es decirle al
 * prospecto que le confirma en breve y escalar, no proponer nada.
 */
export async function consultarDisponibilidad(
  reglas: BookingRules,
  opciones: {
    userId?: string;
    connectedAccountId?: string;
    calendarId?: string;
  } = {},
  ahora: Date = new Date(),
): Promise<Intervalo[]> {
  const hasta = new Date(
    ahora.getTime() + reglas.lookahead_days * 24 * 3600_000,
  );

  const data = await ejecutar<RespuestaHuecos>(
    HERRAMIENTAS.buscarHuecos,
    {
      time_min: ahora.toISOString(),
      time_max: hasta.toISOString(),
      timezone: reglas.timezone,
      items: [{ id: opciones.calendarId ?? "primary" }],
    },
    {
      ...opciones,
      connectedAccountId:
        opciones.connectedAccountId ?? (await cuentaDeCalendario()),
    },
  );

  return calcularHuecos(extraerOcupado(data), reglas, ahora);
}

export type EventoCreado = {
  id: string;
  htmlLink?: string;
  hangoutLink?: string;
  meetUrl?: string;
};

/** Crea el evento con el prospecto invitado y un enlace de Google Meet. */
export async function agendarReunion(
  datos: {
    inicio: Date;
    fin: Date;
    resumen: string;
    descripcion?: string;
    emailInvitado?: string;
    timezone: string;
  },
  opciones: {
    userId?: string;
    connectedAccountId?: string;
    calendarId?: string;
  } = {},
): Promise<EventoCreado> {
  const data = await ejecutar<EventoCreado>(
    HERRAMIENTAS.crearEvento,
    {
      calendar_id: opciones.calendarId ?? "primary",
      summary: datos.resumen,
      description: datos.descripcion,
      start_datetime: datos.inicio.toISOString(),
      event_duration_minutes: Math.round(
        (datos.fin.getTime() - datos.inicio.getTime()) / 60000,
      ),
      timezone: datos.timezone,
      create_meeting_room: true,
      send_updates: true,
      ...(datos.emailInvitado ? { attendees: [datos.emailInvitado] } : {}),
    },
    {
      ...opciones,
      connectedAccountId:
        opciones.connectedAccountId ?? (await cuentaDeCalendario()),
    },
  );

  return { ...data, meetUrl: data.hangoutLink ?? data.meetUrl };
}

/** Formatea un hueco para meterlo en un mensaje, en la zona del prospecto. */
export function describirHueco(hueco: Intervalo, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("es-ES", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(hueco.inicio);
}
