import { asc, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { icps, playbooks } from "@/lib/db/schema";
import { playbookActivo, workspaceActivo } from "@/lib/workspace";
import { EditorPlaybook } from "./editor";

export const dynamic = "force-dynamic";

export default async function PaginaPlaybook() {
  // El que rige para esta empresa: el suyo si lo tiene, y si no el global de
  // fábrica. Coger `isActive` a secas devolvía el de cualquier otra.
  const empresa = await workspaceActivo();
  const activo = await playbookActivo(empresa?.id);

  const [historial, listaIcps] = await Promise.all([
    db
      .select({
        id: playbooks.id,
        name: playbooks.name,
        version: playbooks.version,
        isActive: playbooks.isActive,
        createdAt: playbooks.createdAt,
      })
      .from(playbooks)
      .where(
        empresa
          ? or(
              isNull(playbooks.workspaceId),
              eq(playbooks.workspaceId, empresa.id),
            )
          : isNull(playbooks.workspaceId),
      )
      .orderBy(desc(playbooks.version)),
    db
      .select({ id: icps.id, name: icps.name })
      .from(icps)
      .where(empresa ? eq(icps.workspaceId, empresa.id) : undefined)
      .orderBy(asc(icps.createdAt)),
  ]);

  if (!activo) {
    return (
      <div className="max-w-lg border border-linea bg-lienzo p-8">
        <p className="etiqueta">Sin playbook</p>
        <h1 className="mt-2 text-2xl font-semibold">
          No hay ningún playbook activo
        </h1>
        <p className="mt-3 text-apagado">
          Carga los datos de ejemplo con{" "}
          <code className="font-mono text-tinta">npm run db:seed</code> y vuelve
          aquí.
        </p>
      </div>
    );
  }

  return (
    <EditorPlaybook
      inicial={activo}
      historial={historial.map((h) => ({
        ...h,
        createdAt: h.createdAt.toISOString(),
      }))}
      icps={listaIcps}
      workspaceId={empresa?.id ?? null}
    />
  );
}
