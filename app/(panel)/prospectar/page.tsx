import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns, icps, prospectSearches } from "@/lib/db/schema";
import { workspaceActivo } from "@/lib/workspace";
import { Prospeccion } from "./prospeccion";

export const dynamic = "force-dynamic";

export default async function PaginaProspectar() {
  // Todo de esta empresa. Mezclarlas aquí es lo más peligroso de toda la
  // aplicación: desde esta pantalla se importan candidatos a una campaña, y
  // eso es lo que decide a quién se le acaba escribiendo.
  const empresa = await workspaceActivo();

  const [listaIcps, listaCampanas, busquedas] = await Promise.all([
    db
      .select({ id: icps.id, name: icps.name })
      .from(icps)
      .where(empresa ? eq(icps.workspaceId, empresa.id) : undefined)
      .orderBy(asc(icps.createdAt)),
    db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        channel: campaigns.channel,
      })
      .from(campaigns)
      .where(empresa ? eq(campaigns.workspaceId, empresa.id) : undefined)
      .orderBy(asc(campaigns.createdAt)),
    db
      .select({
        id: prospectSearches.id,
        name: prospectSearches.name,
        source: prospectSearches.source,
        status: prospectSearches.status,
        stats: prospectSearches.stats,
        createdAt: prospectSearches.createdAt,
      })
      .from(prospectSearches)
      .where(empresa ? eq(prospectSearches.workspaceId, empresa.id) : undefined)
      .orderBy(desc(prospectSearches.createdAt))
      .limit(20),
  ]);

  return (
    <Prospeccion
      icps={listaIcps}
      campanas={listaCampanas}
      busquedas={busquedas.map((b) => ({
        ...b,
        createdAt: b.createdAt.toISOString(),
      }))}
    />
  );
}
