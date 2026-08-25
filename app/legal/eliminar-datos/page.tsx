export const metadata = {
  title: "Eliminación de datos · SDR Coto",
  description: "Cómo pedir que se borren tus datos de SDR Coto.",
};

/**
 * Meta exige una URL de eliminación de datos, y tiene que ser una página que
 * EXPLIQUE cómo pedir el borrado.
 *
 * Antes apuntaba al callback de OAuth, que espera parámetros de autorización y
 * ante una visita normal no dice nada. Un revisor que abre ese enlace no
 * encuentra instrucciones y rechaza la solicitud.
 */
export default function EliminarDatos() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">
        Eliminación de datos
      </h1>
      <p className="text-tenue">Última actualización: 25 de agosto de 2026</p>

      <p>
        Puedes pedir que borremos toda la información que tengamos sobre ti. No
        hace falta justificar el motivo.
      </p>

      <h2 className="pt-4 text-lg font-semibold">
        Si eres una cuenta de Instagram conectada
      </h2>
      <p>
        Revoca el acceso desde Instagram, en{" "}
        <strong>Configuración → Apps y sitios web</strong>, eligiendo{" "}
        <strong>SDR Coto</strong>. A partir de ese momento la app deja de tener
        acceso a tu cuenta. Para que además se borre lo ya guardado, escríbenos.
      </p>

      <h2 className="pt-4 text-lg font-semibold">
        Si has comentado o nos has escrito
      </h2>
      <p>
        Escríbenos a{" "}
        <a className="underline" href="mailto:enrique@thecotocompany.com">
          enrique@thecotocompany.com
        </a>{" "}
        desde cualquier dirección, indicando tu nombre de usuario de Instagram o
        el correo con el que te contactamos. También puedes responder{" "}
        <em>&laquo;no me escribas más&raquo;</em> en la propia conversación: eso
        detiene cualquier mensaje futuro de forma inmediata y permanente.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Qué se borra y cuándo</h2>
      <p>
        Se elimina todo lo asociado a ti: nombre de usuario, identificadores,
        comentarios registrados, mensajes intercambiados y datos de contacto. El
        borrado se hace en un plazo máximo de <strong>30 días</strong> desde la
        solicitud, y te confirmamos por correo cuando esté hecho.
      </p>
    </>
  );
}
