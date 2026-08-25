/**
 * Las páginas legales van fuera del panel y sin sesión.
 *
 * Un revisor de Meta las abre desde su navegador, sin haber iniciado sesión
 * nunca: si estuvieran detrás del login, vería la pantalla de acceso y
 * rechazaría la solicitud por política inaccesible.
 */
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-tinta">
      <article className="space-y-5 text-[15px] leading-relaxed">
        {children}
      </article>
      <footer className="mt-16 space-y-2 border-t border-linea pt-6 text-sm text-tenue">
        {/* Enlazadas entre sí: un revisor llega a una y tiene que poder ver las
            otras dos sin volver al formulario de Meta a buscarlas. */}
        <nav className="flex flex-wrap gap-4">
          <a className="underline" href="/legal/privacidad">
            Privacidad
          </a>
          <a className="underline" href="/legal/terminos">
            Condiciones
          </a>
          <a className="underline" href="/legal/eliminar-datos">
            Eliminación de datos
          </a>
        </nav>
        <p>
          The Coto Company ·{" "}
          <a className="underline" href="mailto:enrique@thecotocompany.com">
            enrique@thecotocompany.com
          </a>
        </p>
      </footer>
    </div>
  );
}
