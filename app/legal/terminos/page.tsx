export const metadata = {
  title: "Condiciones del servicio · SDR Coto",
  description: "Qué hace SDR Coto, quién puede usarlo y con qué límites.",
};

/**
 * Meta pide una URL de condiciones del servicio para aprobar la app.
 *
 * Están escritas sobre lo que el sistema hace de verdad, igual que la política
 * de privacidad: unas condiciones genéricas prometen cosas que no existen y
 * callan las que sí, y un revisor que las compara con el comportamiento real
 * encuentra la diferencia.
 */
export default function Terminos() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">
        Condiciones del servicio
      </h1>
      <p className="text-tenue">Última actualización: 25 de agosto de 2026</p>

      <p>
        Estas condiciones regulan el uso de SDR Coto, una herramienta de The
        Coto Company que automatiza el primer contacto comercial y la atención
        de quienes responden. Usar la herramienta implica aceptarlas.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Qué hace</h2>
      <p>SDR Coto, en nombre del negocio que lo utiliza:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Detecta los comentarios que contienen una palabra concreta en las
          publicaciones de las cuentas de Instagram conectadas, y responde a
          esos comentarios.
        </li>
        <li>
          Envía por mensaje privado el recurso que esa persona ha solicitado al
          comentar, y atiende sus respuestas posteriores.
        </li>
        <li>
          Envía correos y mensajes de LinkedIn de primer contacto comercial, y
          responde a quien contesta.
        </li>
        <li>Propone y agenda reuniones en el calendario del negocio.</li>
      </ul>

      <h2 className="pt-4 text-lg font-semibold">Quién puede usarlo</h2>
      <p>
        Solo las personas con credenciales facilitadas por The Coto Company. Las
        credenciales son personales e intransferibles, y quien las tenga es
        responsable de lo que se haga con ellas. Si crees que alguien más las
        conoce, escríbenos y las revocamos.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Cómo NO puede usarse</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Para escribir a quien no ha iniciado ninguna interacción. En
          Instagram, cada mensaje responde a un comentario o a un mensaje de esa
          persona.
        </li>
        <li>
          Para insistir a quien ha pedido no ser contactado. Esa petición se
          atiende de inmediato y de forma permanente, y no se puede desactivar.
        </li>
        <li>
          Para hacerse pasar por otra persona o por otra empresa, ni para negar
          que hay un sistema automático detrás si alguien lo pregunta
          directamente.
        </li>
        <li>
          Para enviar contenido engañoso, ilegal, o que incumpla las condiciones
          de Instagram, Meta, LinkedIn o del proveedor de correo que se esté
          usando.
        </li>
      </ul>
      <p>
        Estas reglas están implementadas en la herramienta, no solo escritas
        aquí. Aun así, el negocio que la usa es responsable del contenido que
        configura.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Plataformas de terceros</h2>
      <p>
        Al conectar una cuenta de Instagram aceptas también las{" "}
        <a
          className="underline"
          href="https://help.instagram.com/581066165581870"
        >
          condiciones de Instagram
        </a>
        . Puedes revocar el acceso en cualquier momento desde Instagram, en
        Configuración → Apps y sitios web, y la herramienta dejará de operar
        sobre esa cuenta de inmediato. No controlamos los cambios que esas
        plataformas hagan en sus APIs ni sus límites de uso.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Datos</h2>
      <p>
        Qué datos se tratan, para qué y durante cuánto tiempo está en la{" "}
        <a className="underline" href="/legal/privacidad">
          política de privacidad
        </a>
        . Cómo pedir el borrado, en{" "}
        <a className="underline" href="/legal/eliminar-datos">
          eliminación de datos
        </a>
        .
      </p>

      <h2 className="pt-4 text-lg font-semibold">
        Disponibilidad y responsabilidad
      </h2>
      <p>
        El servicio se presta tal cual, sin garantía de disponibilidad
        ininterrumpida: depende de servicios de terceros que pueden fallar o
        cambiar. No garantizamos ningún resultado comercial concreto. No
        respondemos de daños indirectos ni del lucro cesante derivado del uso o
        de la imposibilidad de uso.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Cambios y fin del servicio</h2>
      <p>
        Podemos modificar estas condiciones; los cambios relevantes se avisan
        por correo a las personas con acceso. Podemos suspender el acceso de
        quien las incumpla. Puedes dejar de usar el servicio cuando quieras, y
        solicitar el borrado de tus datos.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Ley aplicable</h2>
      <p>
        Se aplica la legislación española. Para cualquier controversia, las
        partes se someten a los juzgados y tribunales que correspondan conforme
        a derecho.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Contacto</h2>
      <p>
        <a className="underline" href="mailto:enrique@thecotocompany.com">
          enrique@thecotocompany.com
        </a>
      </p>
    </>
  );
}
