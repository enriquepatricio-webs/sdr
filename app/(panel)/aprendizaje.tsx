"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Lecciones } from "@/lib/db/schema";

/**
 * Lo que el sistema ha aprendido de sus propios resultados.
 *
 * No son pesos de un modelo: son frases sacadas de comparar los mensajes que
 * obtuvieron respuesta con los que murieron en silencio. Entran en el prompt
 * del agente en cuanto se destilan.
 */
export function Aprendizaje({
  lecciones,
  muestras,
  minimo,
  workspaceId,
}: {
  lecciones: Lecciones | null;
  muestras: number;
  minimo: number;
  /** Sin esto siempre destila las lecciones de la primera empresa. */
  workspaceId: string | null;
}) {
  const router = useRouter();
  const [aprendiendo, aprender] = useTransition();
  const [aviso, setAviso] = useState<string | null>(null);

  const puede = muestras >= minimo;

  return (
    <section className="border border-linea bg-lienzo p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="etiqueta">Lo que va funcionando</h2>
        <button
          type="button"
          disabled={aprendiendo || !puede}
          onClick={() =>
            aprender(async () => {
              setAviso(null);
              const res = await fetch(
                `/api/insights/learn${workspaceId ? `?workspaceId=${workspaceId}` : ""}`,
                { method: "POST" },
              );
              const json = await res.json();
              setAviso(
                json.aprendio
                  ? `Actualizado sobre ${json.lecciones.basadoEn} mensajes.`
                  : (json.explicacion ?? "Todavía no hay datos suficientes."),
              );
              router.refresh();
            })
          }
          className="etiqueta hover:text-tinta disabled:opacity-40"
        >
          {aprendiendo ? "Analizando…" : "Analizar resultados"}
        </button>
      </div>

      {!puede && (
        <p className="mt-2 text-sm text-tenue">
          Llevas <span className="font-mono">{muestras}</span> primeros toques
          enviados. Con menos de <span className="font-mono">{minimo}</span> la
          diferencia entre lo que funciona y lo que no es ruido, y destilar
          ruido produce reglas seguras y falsas.
        </p>
      )}

      {puede && !lecciones && (
        <p className="mt-2 text-sm text-apagado">
          Ya hay datos suficientes ({muestras} mensajes). Pulsa «Analizar
          resultados».
        </p>
      )}

      {lecciones && (
        <>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="etiqueta text-ok">Funciona</p>
              <ul className="mt-1.5 space-y-1.5">
                {lecciones.funciona.map((l, i) => (
                  <li key={i} className="border-l-2 border-ok/40 pl-2 text-sm">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="etiqueta text-vivo">No funciona</p>
              <ul className="mt-1.5 space-y-1.5">
                {lecciones.noFunciona.map((l, i) => (
                  <li
                    key={i}
                    className="border-l-2 border-vivo/40 pl-2 text-sm"
                  >
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-3 border-t border-linea pt-2 text-xs text-tenue">
            Sacado de {lecciones.basadoEn} mensajes ·{" "}
            {new Date(lecciones.actualizado).toLocaleDateString("es-ES")} · ya
            está en el prompt del agente
          </p>
        </>
      )}

      {aviso && <p className="mt-2 text-sm text-ensayo">{aviso}</p>}
    </section>
  );
}
