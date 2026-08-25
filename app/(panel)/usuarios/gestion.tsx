"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Usuario = {
  id: string;
  username: string;
  role: string;
  lastLoginAt: Date | string | null;
};

const entrada =
  "w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo";

/**
 * Quién puede entrar al panel.
 *
 * La razón de que exista: la revisión de Meta pide credenciales con las que un
 * revisor pueda entrar a ver la app. Darle la del dueño significaría que
 * revocarle el acceso obliga a cambiársela a todo el mundo, así que se le crea
 * un usuario aparte que se borra cuando termine.
 */
export function GestionUsuarios({ inicial }: { inicial: Usuario[] }) {
  const router = useRouter();
  const [usuario, setUsuario] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [rol, setRol] = useState<"admin" | "revisor">("revisor");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  async function llamar(metodo: string, cuerpo?: unknown, query = "") {
    setError("");
    setAviso("");
    const res = await fetch(`/api/usuarios${query}`, {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setError(json.error ?? "No se pudo.");
    router.refresh();
    return json;
  }

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    const r = await llamar("POST", { usuario, contrasena, rol });
    if (r?.usuario) {
      setAviso(
        `Creado ${r.usuario}. Apunta la contraseña: no se puede volver a ver.`,
      );
      setUsuario("");
      setContrasena("");
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="etiqueta">Acceso</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Usuarios</h1>
      </header>

      <section className="border border-linea bg-lienzo p-5">
        <h2 className="text-base font-semibold">Quién puede entrar</h2>
        <ul className="mt-3">
          {inicial.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center gap-3 border-t border-linea py-2.5"
            >
              <span className="flex-1 text-sm font-medium">{u.username}</span>
              <span className="font-mono text-[11px] uppercase text-tenue">
                {u.role}
              </span>
              <span className="text-sm text-tenue">
                {u.lastLoginAt
                  ? `entró ${new Date(u.lastLoginAt).toLocaleDateString("es-ES")}`
                  : "nunca ha entrado"}
              </span>
              <button
                type="button"
                onClick={() => {
                  const nueva = prompt(
                    `Nueva contraseña para ${u.username} (mínimo 10):`,
                  );
                  if (nueva) llamar("PATCH", { id: u.id, contrasena: nueva });
                }}
                className="border border-linea-fuerte px-2.5 py-1 text-sm hover:border-tinta"
              >
                Cambiar contraseña
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`¿Quitar el acceso de ${u.username}?`)) {
                    llamar("DELETE", undefined, `?id=${u.id}`);
                  }
                }}
                className="border border-linea-fuerte px-2.5 py-1 text-sm text-vivo hover:border-vivo"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="border border-linea bg-lienzo p-5">
        <h2 className="text-base font-semibold">Añadir usuario</h2>
        <p className="mt-0.5 text-sm text-tenue">
          Para el revisor de Meta, crea uno con rol <strong>revisor</strong> y
          bórralo cuando termine la revisión.
        </p>
        <form onSubmit={crear} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex-1">
            <span className="etiqueta block">Usuario</span>
            <input
              className={entrada}
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="flex-1">
            <span className="etiqueta block">Contraseña</span>
            <input
              className={entrada}
              value={contrasena}
              onChange={(e) => setContrasena(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span className="etiqueta block">Rol</span>
            <select
              className={entrada}
              value={rol}
              onChange={(e) => setRol(e.target.value as "admin" | "revisor")}
            >
              <option value="revisor">revisor</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={!usuario || contrasena.length < 10}
            className="bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40"
          >
            Crear
          </button>
        </form>
        {aviso && <p className="mt-3 text-sm text-ok">{aviso}</p>}
        {error && <p className="mt-3 text-sm text-vivo">{error}</p>}
      </section>
    </div>
  );
}
