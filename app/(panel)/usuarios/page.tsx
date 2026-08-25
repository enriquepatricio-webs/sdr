import { listarUsuarios } from "@/lib/usuarios";
import { GestionUsuarios } from "./gestion";

export const dynamic = "force-dynamic";

export default async function PaginaUsuarios() {
  return <GestionUsuarios inicial={await listarUsuarios()} />;
}
