"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { elegirEmpresa } from "@/lib/empresa";

type Empresa = {
  id: string;
  name: string;
  website: string | null;
  context: string | null;
  offer: string | null;
  scrapedAt: string | null;
  caracteresLeidos: number;
};

type Cuenta = {
  id: string;
  provider: "linkedin" | "email" | "instagram";
  displayName: string;
  status: "active" | "paused" | "disconnected";
  /** null = sin tope por hora. En Instagram eso es arriesgarse a un bloqueo. */
  hourlyLimit: number | null;
  /** El @usuario real, tal como lo devuelve Instagram al autorizar. */
  instagramUsername: string | null;
  /** Cuándo caduca el permiso de Instagram. null = todavía sin autorizar. */
  autorizadaEn: string | null;
  /** Sin empresa asignada: ninguna campaña puede usarla hasta que se le ponga. */
  huerfana: boolean;
};

const entrada =
  "w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo";

const CANALES = [
  { id: "LINKEDIN", etiqueta: "LinkedIn", proveedor: "linkedin" },
  { id: "GOOGLE", etiqueta: "Gmail", proveedor: "email" },
] as const;

const ESTADO: Record<Cuenta["status"], string> = {
  active: "activa",
  paused: "en pausa",
  disconnected: "desconectada",
};

/**
 * Tres preguntas. Ni una más.
 *
 * Todo lo demás que el agente necesita para vender —cómo abre, cuántas veces
 * insiste, qué pregunta, cuándo agenda— viene de fábrica en el playbook global
 * y no se pregunta aquí. Lo único que cambia de una empresa a otra es a qué se
 * dedica, qué dice su web y qué ofrece.
 *
 * Es la misma pantalla para dar de alta y para editar: dar de alta es rellenar
 * esto por primera vez.
 */
export function EditorEmpresa({
  empresa,
  empresaId,
  cuentas,
}: {
  empresa: Empresa | null;
  /** Se pasa aparte porque hace falta aunque el formulario aún no tenga datos. */
  empresaId: string | null;
  cuentas: Cuenta[];
}) {
  const router = useRouter();
  const [datos, setDatos] = useState(empresa);
  const [guardando, guardar] = useTransition();
  const [leyendo, setLeyendo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [nombreNuevo, setNombreNuevo] = useState("");
  const [conectando, setConectando] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);

  function actualizar(cambios: Partial<Empresa>) {
    if (datos) setDatos({ ...datos, ...cambios });
  }

  async function persistir(): Promise<boolean> {
    if (!datos) return false;
    const res = await fetch(`/api/workspaces/${datos.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: datos.name,
        website: datos.website,
        context: datos.context,
        offer: datos.offer,
      }),
    });
    if (res.ok) return true;
    setError((await res.json()).error ?? "No se pudo guardar.");
    return false;
  }

  function guardarEmpresa() {
    guardar(async () => {
      setAviso(null);
      setError(null);
      if (await persistir()) {
        setAviso("Guardado.");
        router.refresh();
      }
    });
  }

  async function leerWeb() {
    if (!datos) return;
    setLeyendo(true);
    setAviso(null);
    setError(null);
    try {
      // Se guarda antes de leer. Si acabas de escribir la web y no has pulsado
      // Guardar, el servidor iría a la URL vieja y no habría forma de notarlo.
      if (!(await persistir())) return;
      const res = await fetch(`/api/workspaces/${datos.id}/scrape`, {
        method: "POST",
      });
      const json = await res.json();
      if (res.ok) {
        actualizar({
          scrapedAt: json.scrapedAt,
          caracteresLeidos: json.caracteres,
        });
        setAviso(
          `Leídos ${json.caracteres.toLocaleString("es-ES")} caracteres.`,
        );
        router.refresh();
      } else setError(json.error ?? "No se pudo leer la web.");
    } finally {
      setLeyendo(false);
    }
  }

  async function crear() {
    setError(null);
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nombreNuevo.trim() }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "No se pudo crear.");
      return;
    }
    // Se pasa a la empresa recién creada: crearla y quedarse en la anterior
    // hace que parezca que no ha pasado nada.
    elegirEmpresa((await res.json()).id);
    setCreando(false);
    setNombreNuevo("");
    router.refresh();
  }

  async function conectar(proveedor: string) {
    setConectando(proveedor);
    setError(null);
    try {
      const res = await fetch("/api/accounts/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "No se pudo generar el enlace.");
        return;
      }
      // En la misma pestaña, no en una nueva: el await rompe la cadena del
      // gesto del usuario y Safari bloquea la ventana emergente.
      window.location.href = json.url;
    } finally {
      setConectando(null);
    }
  }

  async function sincronizar() {
    setSincronizando(true);
    setAviso(null);
    setError(null);
    try {
      // Con el id de la empresa: una cuenta que entra sin dueño no la puede
      // usar ninguna campaña, y el fallo no aparece hasta mucho después.
      const res = await fetch(
        empresaId
          ? `/api/accounts/sync?workspaceId=${empresaId}`
          : "/api/accounts/sync",
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "No se pudo sincronizar.");
        return;
      }
      setAviso(
        json.nuevas?.length
          ? `${json.nuevas.length} cuenta(s) nueva(s). Entran en pausa.`
          : `Sin cambios (${json.encontradas} cuentas vistas).`,
      );
      router.refresh();
    } finally {
      setSincronizando(false);
    }
  }

  function cambiarCuenta(
    id: string,
    cambios: Partial<Cuenta> & { workspaceId?: string },
  ) {
    guardar(async () => {
      const res = await fetch(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cambios),
      });
      if (res.ok) router.refresh();
      else
        setError((await res.json()).error ?? "No se pudo cambiar la cuenta.");
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Tu empresa</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {datos ? datos.name : "Empieza por aquí"}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-apagado">
            Con esto el agente ya sabe para quién habla. Cómo vende no se
            pregunta: viene puesto.
          </p>
        </div>
        {!creando && (
          <button
            type="button"
            onClick={() => setCreando(true)}
            className="border border-linea-fuerte px-3 py-2 text-sm hover:border-tinta"
          >
            Añadir otra empresa
          </button>
        )}
      </header>

      {creando && (
        <div className="border border-linea bg-lienzo p-4">
          <label htmlFor="nueva" className="etiqueta">
            Nombre de la empresa nueva
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="nueva"
              autoFocus
              value={nombreNuevo}
              onChange={(e) => setNombreNuevo(e.target.value)}
              className={entrada}
            />
            <button
              type="button"
              disabled={!nombreNuevo.trim()}
              onClick={crear}
              className="shrink-0 bg-tinta px-4 text-sm font-semibold text-lienzo disabled:opacity-40"
            >
              Crear
            </button>
            <button
              type="button"
              onClick={() => setCreando(false)}
              className="shrink-0 px-3 text-sm text-apagado hover:text-tinta"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {!datos ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">
            Todavía no hay ninguna empresa. Crea una y el agente sabrá para
            quién habla.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-6 border border-linea bg-lienzo p-5">
            <div>
              <label htmlFor="nombre" className="etiqueta">
                Nombre
              </label>
              <input
                id="nombre"
                value={datos.name}
                onChange={(e) => actualizar({ name: e.target.value })}
                className={`${entrada} mt-1.5`}
              />
            </div>

            {/* 1 de 3 */}
            <div>
              <label htmlFor="ctx" className="text-base font-semibold">
                ¿A qué os dedicáis y a quién vendéis?
              </label>
              <p className="mt-0.5 text-sm text-tenue">
                En cuatro líneas. Añade lo que el agente NO debe decir nunca:
                eso es lo que más caro sale.
              </p>
              <textarea
                id="ctx"
                rows={6}
                value={datos.context ?? ""}
                onChange={(e) => actualizar({ context: e.target.value })}
                className={`${entrada} mt-2 resize-y`}
              />
            </div>

            {/* 2 de 3 */}
            <div className="border-t border-linea pt-5">
              <label htmlFor="web" className="text-base font-semibold">
                ¿Cuál es vuestra web?
              </label>
              <p className="mt-0.5 text-sm text-tenue">
                El agente la lee entera y se queda con lo que dice. Si la web se
                contradice con lo de arriba, manda lo de arriba.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  id="web"
                  value={datos.website ?? ""}
                  placeholder="https://…"
                  onChange={(e) => actualizar({ website: e.target.value })}
                  className={`${entrada} flex-1`}
                />
                <button
                  type="button"
                  onClick={leerWeb}
                  disabled={leyendo || !datos.website}
                  className="shrink-0 border border-linea-fuerte px-4 py-2 text-sm hover:border-tinta disabled:opacity-40"
                >
                  {leyendo ? "Leyendo…" : "Leer la web"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-tenue">
                {leyendo
                  ? "Tarda entre 20 y 60 segundos."
                  : datos.scrapedAt
                    ? `Leída el ${new Date(datos.scrapedAt).toLocaleDateString("es-ES")} · ${datos.caracteresLeidos.toLocaleString("es-ES")} caracteres guardados.`
                    : 'Sin leer todavía. Guarda la web y pulsa "Leer la web".'}
              </p>
            </div>

            {/* 3 de 3 */}
            <div className="border-t border-linea pt-5">
              <label htmlFor="oferta" className="text-base font-semibold">
                ¿Hay oferta, garantía o precios?
              </label>
              <p className="mt-0.5 text-sm text-tenue">
                Lo que ofrecéis y en qué condiciones. Si no hay nada de esto,
                déjalo vacío.
              </p>
              <textarea
                id="oferta"
                rows={5}
                value={datos.offer ?? ""}
                onChange={(e) => actualizar({ offer: e.target.value })}
                className={`${entrada} mt-2 resize-y`}
              />
              <p className="mt-1.5 border-l-2 border-linea-fuerte pl-2 text-xs text-apagado">
                Los precios le sirven al agente para razonar, pero{" "}
                <strong>no dice cifras de dinero por mensaje, nunca</strong>. El
                dinero se habla en la reunión.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-linea pt-5">
              <button
                type="button"
                onClick={guardarEmpresa}
                disabled={guardando}
                className="bg-tinta px-5 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40"
              >
                {guardando ? "Guardando…" : "Guardar"}
              </button>
              {aviso && <p className="text-sm text-ok">{aviso}</p>}
              {error && <p className="text-sm text-vivo">{error}</p>}
            </div>
          </div>

          <section className="border border-linea bg-lienzo p-5">
            <h2 className="text-base font-semibold">
              Cuentas desde las que escribe
            </h2>
            <p className="mt-0.5 text-sm text-tenue">
              Tus credenciales se meten en la pantalla de Unipile: aquí no se
              ven ni se guardan. Una cuenta recién conectada entra{" "}
              <strong>en pausa</strong>.
            </p>

            <ul className="mt-4">
              {CANALES.map(({ id, etiqueta, proveedor }) => {
                // Todas, no la primera: con dos LinkedIn conectados, quedarse
                // con uno esconde una cuenta que sí está escribiendo.
                const suyas = cuentas.filter((c) => c.provider === proveedor);
                return (
                  <li
                    key={id}
                    className="flex flex-wrap items-center gap-3 border-t border-linea py-2.5"
                  >
                    <span className="w-24 shrink-0 text-sm font-medium">
                      {etiqueta}
                    </span>
                    {suyas.length === 0 ? (
                      <>
                        <span className="flex-1 text-sm text-tenue">
                          Sin conectar
                        </span>
                        <button
                          type="button"
                          disabled={conectando !== null}
                          onClick={() => conectar(id)}
                          className="border border-linea-fuerte px-3 py-1.5 text-sm hover:border-tinta disabled:opacity-40"
                        >
                          {conectando === id ? "Abriendo…" : "Conectar"}
                        </button>
                      </>
                    ) : (
                      <ul className="flex-1 space-y-1.5">
                        {suyas.map((cuenta) => (
                          <li
                            key={cuenta.id}
                            className="flex items-center gap-3"
                          >
                            <span className="flex-1 truncate text-sm text-apagado">
                              {cuenta.displayName}
                            </span>
                            <select
                              value={cuenta.status}
                              onChange={(e) =>
                                cambiarCuenta(cuenta.id, {
                                  status: e.target.value as Cuenta["status"],
                                })
                              }
                              aria-label={`Estado de ${cuenta.displayName}`}
                              className={`border border-linea-fuerte bg-papel px-2 py-1 text-xs ${
                                cuenta.status === "active"
                                  ? "text-ok"
                                  : "text-apagado"
                              }`}
                            >
                              {(Object.keys(ESTADO) as Cuenta["status"][]).map(
                                (s) => (
                                  <option key={s} value={s}>
                                    {ESTADO[s]}
                                  </option>
                                ),
                              )}
                            </select>
                          </li>
                        ))}
                        {suyas.some((c) => c.huerfana) && empresaId && (
                          <li className="text-xs text-aviso">
                            Sin empresa asignada, así que ninguna campaña puede
                            usarla.{" "}
                            <button
                              type="button"
                              disabled={guardando}
                              onClick={() =>
                                suyas
                                  .filter((c) => c.huerfana)
                                  .forEach((c) =>
                                    cambiarCuenta(c.id, {
                                      workspaceId: empresaId,
                                    }),
                                  )
                              }
                              className="underline hover:text-tinta disabled:opacity-40"
                            >
                              Asignarla a esta empresa
                            </button>
                          </li>
                        )}
                        {/* Sin el @usuario real no se puede comprobar quién te
                            sigue, y el lead magnet no entrega el recurso a
                            nadie. No se adivina desde el nombre: se pregunta. */}
                        {suyas.some(
                          (c) =>
                            c.provider === "instagram" && !c.instagramUsername,
                        ) && (
                          <li className="text-xs text-aviso">
                            Falta el @usuario de Instagram. Sin él los lead
                            magnets no pueden comprobar quién te sigue.{" "}
                            <button
                              type="button"
                              disabled={guardando}
                              onClick={() => {
                                const c = suyas.find(
                                  (x) =>
                                    x.provider === "instagram" &&
                                    !x.instagramUsername,
                                );
                                if (!c) return;
                                const v = window.prompt(
                                  `¿Cuál es el @usuario de Instagram de "${c.displayName}"?`,
                                  "",
                                );
                                if (v?.trim())
                                  cambiarCuenta(c.id, {
                                    instagramUsername: v.trim(),
                                  });
                              }}
                              className="underline hover:text-tinta disabled:opacity-40"
                            >
                              Ponerlo
                            </button>
                          </li>
                        )}
                        {/* Instagram admite 100 acciones al día pero no más de
                            10 por hora. Sin tope horario, el bloqueo es cuestión
                            de tiempo, y aquí ya no hay campo donde ponerlo. */}
                        {suyas.some(
                          (c) =>
                            c.provider === "instagram" &&
                            c.hourlyLimit === null,
                        ) && (
                          <li className="text-xs text-aviso">
                            Sin tope por hora. Instagram bloquea por encima de
                            10 acciones/hora.{" "}
                            <button
                              type="button"
                              disabled={guardando}
                              onClick={() =>
                                suyas
                                  .filter((c) => c.hourlyLimit === null)
                                  .forEach((c) =>
                                    cambiarCuenta(c.id, { hourlyLimit: 8 }),
                                  )
                              }
                              className="underline hover:text-tinta disabled:opacity-40"
                            >
                              Poner 8 por hora
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              disabled={sincronizando}
              onClick={sincronizar}
              className="etiqueta mt-3 hover:text-tinta disabled:opacity-40"
            >
              {sincronizando ? "Sincronizando…" : "Sincronizar con Unipile"}
            </button>

            {/*
              Instagram va aparte y no por Unipile: usa la API oficial de Meta,
              que avisa de los comentarios en vez de obligar a ir a mirarlos.
              Autorizar es un salto a instagram.com y vuelta, así que es un
              enlace de verdad y no un fetch: un fetch no puede enseñarte la
              pantalla de permisos de Instagram.
            */}
            {cuentas.some((c) => c.provider === "instagram") && (
              <div className="mt-6 border-t border-linea pt-4">
                <h3 className="text-sm font-semibold">Instagram</h3>
                <p className="mt-0.5 text-sm text-tenue">
                  Va por la app de Meta. Autorizar abre Instagram, te pide
                  permiso y vuelve aquí. El permiso dura 60 días.
                </p>
                <ul className="mt-3">
                  {cuentas
                    .filter((c) => c.provider === "instagram")
                    .map((cuenta) => (
                      <li
                        key={cuenta.id}
                        className="flex flex-wrap items-center gap-3 border-t border-linea py-2.5"
                      >
                        <span className="flex-1 truncate text-sm">
                          {cuenta.instagramUsername
                            ? `@${cuenta.instagramUsername}`
                            : cuenta.displayName}
                        </span>
                        <span
                          className={`font-mono text-[11px] uppercase ${
                            cuenta.autorizadaEn ? "text-ok" : "text-tenue"
                          }`}
                        >
                          {cuenta.autorizadaEn
                            ? `autorizada hasta ${new Date(cuenta.autorizadaEn).toLocaleDateString("es-ES")}`
                            : "sin autorizar"}
                        </span>
                        <a
                          href={`/api/meta/oauth/start?account_id=${cuenta.id}`}
                          className="border border-linea-fuerte px-3 py-1.5 text-sm hover:border-tinta"
                        >
                          {cuenta.autorizadaEn ? "Renovar" : "Autorizar"}
                        </a>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
