/**
 * Pruebas de los clientes de Unipile y Composio contra respuestas simuladas.
 * `npm run test:integraciones`.
 *
 * No tocan la red: se sustituye `fetch`. Lo que se prueba es lo que de verdad
 * puede romper en producción — la forma de la petición, el bucle del webhook y
 * el cálculo de huecos — no que un servidor ajeno esté vivo.
 */
import assert from "node:assert/strict";
import type { BookingRules } from "./db/schema";
import {
  cuentaDeCalendario,
  calcularHuecos,
  consultarDisponibilidad,
  describirHueco,
} from "./composio";
import {
  MAX_CARACTERES_INVITACION,
  UnipileError,
  notaDeInvitacion,
  interpretarWebhook,
  invitar,
  iniciarChat,
} from "./unipile";
import {
  DESTINATARIO_IMPOSIBLE,
  YA_TIENE_LA_INVITACION,
  tipoDeErrorUnipile,
} from "../app/api/messages/send/route";

let ok = 0;
const fallos: string[] = [];

async function prueba(nombre: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fallos.push(`${nombre}\n    ${(err as Error).message.split("\n")[0]}`);
  }
}

process.env.UNIPILE_API_KEY = "clave-de-prueba";
process.env.UNIPILE_DSN = "api8.unipile.com:13843";
process.env.COMPOSIO_API_KEY = "clave-composio";

type Captura = { url: string; init: RequestInit };
const original = globalThis.fetch;

function simular(respuesta: unknown, estado = 200): Captura[] {
  const capturas: Captura[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init: RequestInit = {},
  ) => {
    capturas.push({ url: String(url), init });
    return new Response(JSON.stringify(respuesta), {
      status: estado,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return capturas;
}

/* ---- Unipile: construcción de la petición ------------------------------- */

await prueba("el DSN se convierte en una URL correcta", async () => {
  const c = simular({ chat_id: "c1", message_id: "m1" });
  await iniciarChat({ accountId: "a1", attendeeId: "ACo123", texto: "hola" });
  assert.equal(c[0].url, "https://api8.unipile.com:13843/api/v1/chats");
});

await prueba("se manda la cabecera X-API-KEY", async () => {
  const c = simular({ chat_id: "c1", message_id: "m1" });
  await iniciarChat({ accountId: "a1", attendeeId: "ACo123", texto: "hola" });
  const headers = c[0].init.headers as Record<string, string>;
  assert.equal(headers["X-API-KEY"], "clave-de-prueba");
});

await prueba(
  "abrir chat va como multipart y SIN Content-Type manual",
  async () => {
    const c = simular({ chat_id: "c1", message_id: "m1" });
    await iniciarChat({ accountId: "a1", attendeeId: "ACo123", texto: "hola" });
    const headers = c[0].init.headers as Record<string, string>;
    // Ponerlo a mano rompe el boundary de multipart y Unipile devuelve un 400 opaco.
    assert.equal(headers["Content-Type"], undefined);
    assert.ok(c[0].init.body instanceof FormData);
    assert.equal((c[0].init.body as FormData).get("text"), "hola");
  },
);

await prueba("el InMail solo se pide cuando se pide", async () => {
  let c = simular({ chat_id: "c1", message_id: "m1" });
  await iniciarChat({ accountId: "a1", attendeeId: "ACo1", texto: "x" });
  assert.equal((c[0].init.body as FormData).get("linkedin[inmail]"), null);

  c = simular({ chat_id: "c1", message_id: "m1" });
  await iniciarChat({
    accountId: "a1",
    attendeeId: "ACo1",
    texto: "x",
    inmail: true,
  });
  assert.equal((c[0].init.body as FormData).get("linkedin[inmail]"), "true");
});

await prueba("la invitación va como JSON", async () => {
  const c = simular({ invitation_id: "i1" });
  await invitar({ accountId: "a1", providerId: "ACo1", mensaje: "hola" });
  const headers = c[0].init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(c[0].init.body as string), {
    account_id: "a1",
    provider_id: "ACo1",
    message: "hola",
  });
});

await prueba(
  "una nota de invitación demasiado larga falla en vez de recortarse",
  async () => {
    simular({ invitation_id: "i1" });
    await assert.rejects(
      () =>
        invitar({
          accountId: "a1",
          providerId: "ACo1",
          mensaje: "x".repeat(MAX_CARACTERES_INVITACION + 1),
        }),
      // El mensaje de error tiene que decir el tope real, sea cual sea.
      new RegExp(String(MAX_CARACTERES_INVITACION)),
    );
  },
);

await prueba("un error de Unipile se propaga con su estado", async () => {
  simular({ error: "nope" }, 422);
  await assert.rejects(
    () => iniciarChat({ accountId: "a1", attendeeId: "x", texto: "y" }),
    /422/,
  );
});

/* ---- Unipile: el bucle infinito ----------------------------------------- */

await prueba("un mensaje del prospecto se reconoce como entrante", () => {
  const e = interpretarWebhook({
    event: "message_received",
    account_id: "acc1",
    account_info: { user_id: "YO-123" },
    chat_id: "chat1",
    message_id: "msg1",
    message: "no me interesa",
    sender: { attendee_provider_id: "ELLOS-999", attendee_name: "Marta" },
  });
  assert.equal(e?.esNuestro, false);
  assert.equal(e?.texto, "no me interesa");
  assert.equal(e?.remitenteNombre, "Marta");
});

await prueba(
  "NUESTRO propio mensaje se reconoce como eco y no como respuesta",
  () => {
    // Unipile incluye los mensajes enviados en message_received. Sin esta
    // comprobación el agente se contesta a sí mismo, en bucle, sobre un hilo
    // con una persona real dentro.
    const e = interpretarWebhook({
      event: "message_received",
      account_info: { user_id: "YO-123" },
      chat_id: "chat1",
      message_id: "msg2",
      message: "¿te viene bien el martes?",
      sender: { attendee_provider_id: "YO-123" },
    });
    assert.equal(e?.esNuestro, true);
  },
);

await prueba("sin user_id no se marca como nuestro por si acaso", () => {
  const e = interpretarWebhook({
    event: "message_received",
    chat_id: "c",
    message_id: "m",
    sender: { attendee_provider_id: "ALGUIEN" },
  });
  assert.equal(e?.esNuestro, false);
});

await prueba("otros eventos se ignoran", () => {
  assert.equal(
    interpretarWebhook({
      event: "message_read",
      chat_id: "c",
      message_id: "m",
    }),
    null,
  );
});

await prueba("un webhook sin chat_id o message_id se descarta", () => {
  assert.equal(
    interpretarWebhook({ event: "message_received", message: "x" }),
    null,
  );
});

/* ---- Composio: cálculo de huecos ---------------------------------------- */

const REGLAS: BookingRules = {
  duration_min: 30,
  min_notice_hours: 4,
  buffer_min: 15,
  lookahead_days: 7,
  timezone: "Europe/Madrid",
  working_hours: { from: "09:30", to: "18:30", days: [1, 2, 3, 4, 5] },
  min_score_to_book: 60,
  max_slots_offered: 2,
};

// Lunes 17 de agosto de 2026, 08:00 UTC = 10:00 en Madrid.
const LUNES = new Date("2026-08-17T08:00:00Z");

await prueba("con la agenda vacía propone huecos", () => {
  const h = calcularHuecos([], REGLAS, LUNES);
  assert.equal(h.length, 2);
});

await prueba("respeta la antelación mínima", () => {
  const h = calcularHuecos([], REGLAS, LUNES);
  const minimo = LUNES.getTime() + 4 * 3600_000;
  assert.ok(
    h[0].inicio.getTime() >= minimo,
    `propuso ${h[0].inicio.toISOString()}, demasiado pronto`,
  );
});

await prueba("nunca propone fuera del horario laboral", () => {
  const h = calcularHuecos([], { ...REGLAS, max_slots_offered: 5 }, LUNES);
  for (const x of h) {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(x.inicio);
    const hh = Number(p.find((q) => q.type === "hour")!.value);
    const mm = Number(p.find((q) => q.type === "minute")!.value);
    const min = hh * 60 + mm;
    assert.ok(min >= 9 * 60 + 30, `empieza a las ${hh}:${mm}, antes de abrir`);
    assert.ok(
      min + REGLAS.duration_min <= 18 * 60 + 30,
      `termina después de cerrar`,
    );
  }
});

await prueba("nunca propone sábado ni domingo", () => {
  const h = calcularHuecos(
    [],
    { ...REGLAS, max_slots_offered: 5, lookahead_days: 14 },
    LUNES,
  );
  for (const x of h) {
    const dow = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      weekday: "short",
    }).format(x.inicio);
    assert.ok(!["Sat", "Sun"].includes(dow), `propuso un ${dow}`);
  }
});

await prueba("respeta el colchón alrededor de lo que ya hay", () => {
  // Ocupado todo el lunes salvo un agujero de 30 min exactos: con 15 min de
  // colchón por lado no cabe, así que ese agujero NO puede proponerse.
  const ocupado = [
    {
      inicio: new Date("2026-08-17T07:30:00Z"),
      fin: new Date("2026-08-17T14:00:00Z"),
    },
    {
      inicio: new Date("2026-08-17T14:30:00Z"),
      fin: new Date("2026-08-17T16:30:00Z"),
    },
  ];
  const h = calcularHuecos(ocupado, { ...REGLAS, max_slots_offered: 5 }, LUNES);
  const elLunes = h.filter((x) =>
    x.inicio.toISOString().startsWith("2026-08-17"),
  );
  assert.equal(
    elLunes.length,
    0,
    "metió una reunión en un agujero sin colchón",
  );
});

await prueba("con la agenda llena no inventa nada", () => {
  const ocupado = Array.from({ length: 14 }, (_, i) => ({
    inicio: new Date(Date.UTC(2026, 7, 17 + i, 0, 0)),
    fin: new Date(Date.UTC(2026, 7, 18 + i, 0, 0)),
  }));
  assert.deepEqual(calcularHuecos(ocupado, REGLAS, LUNES), []);
});

await prueba("reparte: como mucho un hueco por día", () => {
  const h = calcularHuecos([], { ...REGLAS, max_slots_offered: 4 }, LUNES);
  const dias = new Set(h.map((x) => x.inicio.toISOString().slice(0, 10)));
  assert.equal(dias.size, h.length, "ofreció dos huecos del mismo día");
});

await prueba("la duración del hueco es la del playbook", () => {
  const h = calcularHuecos([], { ...REGLAS, duration_min: 45 }, LUNES);
  assert.equal((h[0].fin.getTime() - h[0].inicio.getTime()) / 60000, 45);
});

/* ---- Composio: elegir la conexion --------------------------------------- */

await prueba("se elige la conexión de calendario que está viva", async () => {
  // Caso real: cuatro conexiones de Google Calendar en la misma cuenta, dos
  // caducadas. Coger la primera que aparezca da un 400 que no dice nada.
  simular({
    items: [
      { id: "ca_drive", toolkit: { slug: "googledrive" }, status: "ACTIVE" },
      {
        id: "ca_vieja",
        toolkit: { slug: "googlecalendar" },
        status: "EXPIRED",
      },
      { id: "ca_buena", toolkit: { slug: "googlecalendar" }, status: "ACTIVE" },
    ],
  });
  assert.equal(await cuentaDeCalendario(), "ca_buena");
});

await prueba("sin ninguna conexión viva se explica por qué", async () => {
  // Devolver null aquí acabaría en un 400 de Composio sobre user_id, que no
  // tiene nada que ver con lo que de verdad pasa: hay que reconectar.
  simular({
    items: [
      {
        id: "ca_vieja",
        toolkit: { slug: "googlecalendar" },
        status: "EXPIRED",
      },
    ],
  });
  await assert.rejects(() => cuentaDeCalendario(), /caducad|reconect/i);
});

/* ---- Composio: la llamada ------------------------------------------------ */

await prueba("consultarDisponibilidad pide el rango correcto", async () => {
  const c = simular({
    successful: true,
    data: { calendars: { primary: { busy: [] } } },
  });
  await consultarDisponibilidad(
    REGLAS,
    { connectedAccountId: "ca_prueba" },
    LUNES,
  );
  assert.ok(c[0].url.includes("GOOGLECALENDAR_FIND_FREE_SLOTS"));
  const body = JSON.parse(c[0].init.body as string);
  assert.equal(body.arguments.timezone, "Europe/Madrid");
  assert.equal(body.arguments.time_min, LUNES.toISOString());
  assert.ok(body.version, "debe mandar versión explícita del toolkit");
});

await prueba("un successful:false lanza aunque el HTTP sea 200", async () => {
  // Si esto devolviera [] en vez de lanzar, el agente no podría distinguir
  // "no tengo hueco" de "no he podido mirar", y acabaría inventándose uno.
  simular({ successful: false, error: "token caducado" });
  await assert.rejects(
    () =>
      consultarDisponibilidad(
        REGLAS,
        { connectedAccountId: "ca_prueba" },
        LUNES,
      ),
    /token caducado/,
  );
});

await prueba("un 500 de Composio lanza", async () => {
  simular({ error: "boom" }, 500);
  await assert.rejects(
    () =>
      consultarDisponibilidad(
        REGLAS,
        { connectedAccountId: "ca_prueba" },
        LUNES,
      ),
    /500/,
  );
});

await prueba(
  "los huecos ocupados que devuelve Composio se respetan",
  async () => {
    simular({
      successful: true,
      data: {
        calendars: {
          primary: {
            busy: [
              { start: "2026-08-17T07:00:00Z", end: "2026-08-17T20:00:00Z" },
            ],
          },
        },
      },
    });
    const h = await consultarDisponibilidad(
      REGLAS,
      { connectedAccountId: "ca_prueba" },
      LUNES,
    );
    const elLunes = h.filter((x) =>
      x.inicio.toISOString().startsWith("2026-08-17"),
    );
    assert.equal(elLunes.length, 0);
  },
);

await prueba(
  "el hueco se describe en la zona del prospecto y en español",
  () => {
    const texto = describirHueco(
      {
        inicio: new Date("2026-08-17T08:00:00Z"),
        fin: new Date("2026-08-17T08:30:00Z"),
      },
      "Europe/Madrid",
    );
    assert.match(texto, /lunes/);
    assert.match(texto, /10:00/);
  },
);

globalThis.fetch = original;

/* ---- La nota de una invitación de LinkedIn -------------------------------- */
/* Es lo PRIMERO que ve un desconocido. Pasarse de 200 hace que Unipile devuelva
   400 y el lead se queme; cortar a mitad de frase da la impresión contraria a
   la que busca el playbook. */

await prueba("una nota corta se deja tal cual", () => {
  const corta =
    "Hola Ana, vi que abrís segundo local. ¿Te cuento algo en dos líneas?";
  assert.equal(notaDeInvitacion(corta), corta);
});

await prueba("nunca supera el tope de LinkedIn", () => {
  const larga =
    "Frase de relleno bastante larga para pasarse del tope. ".repeat(20);
  assert.ok(
    notaDeInvitacion(larga).length <= MAX_CARACTERES_INVITACION + 1,
    "la nota recortada seguía siendo más larga de lo que LinkedIn admite",
  );
});

await prueba("corta en un punto, no a mitad de palabra", () => {
  const texto =
    "Hola, no nos conocemos. Vi que lleváis tres locales abiertos en Madrid y me llamó la atención cómo tenéis montada la carta. Trabajo con restaurantes en algo muy concreto y quería preguntarte una cosa rápida sobre vuestro equipo de sala.";
  const nota = notaDeInvitacion(texto);
  assert.ok(nota.length <= MAX_CARACTERES_INVITACION + 1);
  assert.ok(
    nota.endsWith(".") || nota.endsWith("…"),
    `la nota acabó de forma abrupta: "${nota.slice(-30)}"`,
  );
  assert.ok(!nota.includes("  "), "quedó un espacio doble al cortar");
});

/* ---- El eco, con el payload REAL de producción --------------------------- */
/* Este es literalmente el cuerpo que mandó Unipile el 24/8 a las 10:39, con los
   identificadores tal cual llegaron. Se detectaba como escrito por el prospecto
   y el agente habría contestado a nuestro propio mensaje, en un hilo con una
   persona real delante. */

const ECO_REAL = {
  event: "message_received",
  account_id: "dWigdUJzQCC0Nw2_6Wqy2w",
  account_type: "INSTAGRAM",
  // Ojo: este user_id NO es el mismo número que el attendee_provider_id del
  // remitente, aunque sean la misma cuenta. Ahí estaba el fallo.
  account_info: { type: "INSTAGRAM", user_id: "6681108632" },
  chat_id: "Mp-voy-aXq-S4PuPd-EBJw",
  message_id: "jfRxEMUeV8-ie7oCqtsFuQ",
  message: "Hola, no nos conocemos de nada. Veo que ofrecéis incentivos…",
  is_sender: true,
  sender: {
    attendee_id: "iUmp3gKMViy6OCqDvsumjw",
    attendee_provider_id: "100216134716349",
    attendee_name: "Kike",
    attendee_profile_url: "https://www.instagram.com/enriique.pga/",
    attendee_specifics: {
      provider: "INSTAGRAM",
      public_identifier: "enriique.pga",
    },
  },
  attendees: [
    {
      attendee_id: "0vcd2pbvXj-dRzRE7U4YSA",
      attendee_provider_id: "117082913011103",
      attendee_name: "SOMOSCASA",
      attendee_profile_url: "https://www.instagram.com/somoscasabarcelona/",
      attendee_specifics: {
        provider: "INSTAGRAM",
        public_identifier: "somoscasabarcelona",
      },
    },
  ],
};

await prueba(
  "un mensaje NUESTRO se reconoce como eco aunque los ids no casen",
  () => {
    const e = interpretarWebhook(ECO_REAL);
    assert.ok(e);
    assert.equal(
      e.esNuestro,
      true,
      "el agente se pondría a responder a sus propios mensajes en un hilo real",
    );
  },
);

await prueba("del eco se saca el @usuario del PROSPECTO, no el nuestro", () => {
  const e = interpretarWebhook(ECO_REAL);
  assert.equal(e?.remitenteUsuario, "somoscasabarcelona");
});

await prueba("en una respuesta de verdad, el usuario es quien escribe", () => {
  const respuesta = {
    ...ECO_REAL,
    is_sender: false,
    message: "Cuéntame",
    sender: ECO_REAL.attendees[0],
    attendees: [ECO_REAL.sender],
  };
  const e = interpretarWebhook(respuesta);
  assert.equal(e?.esNuestro, false);
  assert.equal(e?.remitenteUsuario, "somoscasabarcelona");
});

await prueba("si falta is_sender, se cae al respaldo de comparar ids", () => {
  const sinBandera = { ...ECO_REAL, is_sender: undefined };
  const e = interpretarWebhook(sinBandera);
  // Los ids no coinciden, así que el respaldo dice que no es nuestro: es
  // justamente el caso que hacía falta cubrir con is_sender.
  assert.equal(e?.esNuestro, false);
});

/**
 * Cuerpos copiados tal cual de run_logs. Si Unipile cambia la forma del `type`,
 * la clasificación deja de funcionar EN SILENCIO: los leads siguen fallando,
 * solo que por el camino largo de tres intentos.
 */
const CUERPOS = {
  invalid_recipient:
    '{"status":422,"type":"errors/invalid_recipient","title":"Recipient cannot be reached","detail":"Make sure that the recipient ID is valid and that the corresponding profile is not locked."}',
  cannot_resend_yet:
    '{"status":422,"type":"errors/cannot_resend_yet","title":"Cannot resend yet","detail":"..."}',
  provider_error:
    '{"status":500,"type":"errors/provider_error","title":"Provider error","detail":"..."}',
};

await prueba(
  "se reconoce el tipo de error dentro del cuerpo de Unipile",
  () => {
    for (const [tipo, cuerpo] of Object.entries(CUERPOS)) {
      assert.equal(
        tipoDeErrorUnipile(new UnipileError("x", 422, cuerpo)),
        tipo,
      );
    }
  },
);

await prueba("un error que no es de Unipile no se clasifica", () => {
  assert.equal(tipoDeErrorUnipile(new Error("se cayó la red")), null);
});

await prueba("un perfil bloqueado no se reintenta; un 500 sí", () => {
  assert.ok(DESTINATARIO_IMPOSIBLE.includes("invalid_recipient"));
  // El 500 fuera de la lista es deliberado: era el sintoma de nuestro propio
  // bug del identificador de Google Maps, y habria quemado 34 leads buenos.
  assert.ok(!DESTINATARIO_IMPOSIBLE.includes("provider_error"));
  assert.ok(!DESTINATARIO_IMPOSIBLE.includes(YA_TIENE_LA_INVITACION));
});

console.log(`\n${ok} comprobaciones correctas`);
if (fallos.length) {
  console.error(`\n${fallos.length} FALLOS:\n`);
  for (const f of fallos) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log("Clientes de Unipile y Composio verificados.");
