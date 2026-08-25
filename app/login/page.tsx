"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function Formulario() {
  const router = useRouter();
  const siguiente = useSearchParams().get("next") ?? "/";
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEntrando(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, password }),
    });
    if (res.ok) {
      router.replace(siguiente);
      router.refresh();
    } else {
      setError((await res.json()).error ?? "No se pudo entrar.");
      setEntrando(false);
    }
  }

  return (
    <form
      onSubmit={entrar}
      className="w-full max-w-sm border border-linea bg-lienzo p-8"
    >
      <p className="font-mono text-sm font-bold tracking-[0.18em] uppercase">
        SDR
      </p>
      <h1 className="mt-6 text-xl font-semibold">Entrar</h1>

      <label htmlFor="usuario" className="etiqueta mt-6 block">
        Usuario
      </label>
      <input
        id="usuario"
        autoFocus
        autoComplete="username"
        value={usuario}
        onChange={(e) => setUsuario(e.target.value)}
        className="mt-1.5 w-full border border-linea-fuerte bg-papel px-3 py-2 outline-none focus:border-ensayo"
      />

      <label htmlFor="password" className="etiqueta mt-4 block">
        Contraseña
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1.5 w-full border border-linea-fuerte bg-papel px-3 py-2 outline-none focus:border-ensayo"
      />

      {error && (
        <p
          role="alert"
          className="mt-3 border-l-2 border-vivo bg-vivo-suave px-3 py-2 text-sm text-vivo"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={entrando || !usuario || !password}
        className="mt-6 w-full bg-tinta py-2.5 text-sm font-semibold text-lienzo transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {entrando ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}

export default function PaginaLogin() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Suspense>
        <Formulario />
      </Suspense>
    </div>
  );
}
