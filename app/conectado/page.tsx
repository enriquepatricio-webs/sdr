import Link from 'next/link'

/**
 * Aterrizaje tras el asistente de Unipile.
 *
 * Es PÚBLICA a propósito. La vuelta desde Unipile es una navegación entre
 * sitios distintos, y si el navegador no manda la cookie de sesión en ese salto
 * (SameSite=Lax no la manda en todos los casos), aterrizar en una ruta
 * protegida rebota al login y parece que te ha cerrado la sesión. No la ha
 * cerrado: la cookie sigue ahí y funciona en cuanto navegas dentro del sitio.
 */
export default async function Conectado({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string }>
}) {
  const { ok } = await searchParams
  const fue = ok !== '0'

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md border border-linea bg-lienzo p-8">
        <p className="font-mono text-sm font-bold tracking-[0.18em] uppercase">SDR</p>

        {fue ? (
          <>
            <h1 className="mt-6 text-xl font-semibold">Cuenta conectada</h1>
            <p className="mt-2 text-sm text-apagado">
              Vuelve a Ajustes y pulsa <strong>Sincronizar</strong> para traerla. Entrará en
              pausa: activarla es una decisión aparte.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-xl font-semibold">No se completó la conexión</h1>
            <p className="mt-2 text-sm text-apagado">
              El asistente de Unipile se cerró sin terminar. Puedes volver a intentarlo desde
              Ajustes.
            </p>
          </>
        )}

        <Link
          href="/settings"
          className="mt-6 block bg-tinta py-2.5 text-center text-sm font-semibold text-lienzo"
        >
          Volver a Ajustes
        </Link>
      </div>
    </div>
  )
}
