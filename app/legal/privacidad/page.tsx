export const metadata = {
  title: "Política de privacidad · SDR Coto",
  description: "Qué datos trata SDR Coto, para qué y durante cuánto tiempo.",
};

/**
 * Escrita sobre lo que el sistema hace DE VERDAD.
 *
 * Una política copiada de una plantilla es peor que no tenerla: describe
 * tratamientos que no existen y omite los que sí, y es lo primero que mira un
 * revisor de Meta antes de aprobar permisos de comentarios y mensajes.
 */
export default function Privacidad() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">
        Política de privacidad
      </h1>
      <p className="text-tenue">Última actualización: 25 de agosto de 2026</p>

      <p>
        SDR Coto es una herramienta interna de The Coto Company que automatiza
        el primer contacto comercial y la atención de las personas que
        responden. Esta política explica qué datos trata, con qué finalidad y
        durante cuánto tiempo.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Responsable</h2>
      <p>
        The Coto Company. Contacto:{" "}
        <a className="underline" href="mailto:enrique@thecotocompany.com">
          enrique@thecotocompany.com
        </a>
        .
      </p>

      <h2 className="pt-4 text-lg font-semibold">Datos de Instagram</h2>
      <p>
        Cuando se conecta una cuenta de Instagram profesional mediante el inicio
        de sesión de Instagram, tratamos:
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>El nombre de usuario y el identificador de la cuenta conectada.</li>
        <li>
          El texto, el identificador y la fecha de los comentarios publicados en
          las publicaciones de esa cuenta.
        </li>
        <li>El nombre de usuario y el identificador de quienes comentan.</li>
        <li>
          Si esa persona sigue a la cuenta, cuando nos escribe y únicamente para
          comprobar la condición que se le ha comunicado por escrito.
        </li>
        <li>
          El contenido de los mensajes directos intercambiados con esas
          personas.
        </li>
      </ul>
      <p>
        Estos datos se usan solo para detectar quién ha solicitado un recurso,
        entregárselo por mensaje privado y mantener la conversación que esa
        persona ha iniciado. No se venden, no se ceden a terceros con fines
        comerciales y no se usan para publicidad ni para crear perfiles
        publicitarios.
      </p>
      <p>
        La app nunca escribe a alguien que no haya interactuado antes con la
        cuenta: cada mensaje responde a un comentario o a un mensaje suyo.
      </p>

      <h2 className="pt-4 text-lg font-semibold">
        Datos de contacto profesional
      </h2>
      <p>
        Para la prospección por correo y LinkedIn tratamos datos profesionales
        publicados por las propias empresas o disponibles en fuentes públicas:
        nombre, cargo, empresa, dirección de correo profesional, perfil de
        LinkedIn y sitio web. Se usan para un primer contacto comercial
        identificado, y cualquier persona puede pedir no volver a ser contactada
        respondiendo al mensaje: la petición se atiende de inmediato y de forma
        permanente.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Con quién se comparten</h2>
      <p>
        Solo con los proveedores necesarios para que el servicio funcione, y
        únicamente para eso: Neon (base de datos, Unión Europea), Vercel
        (alojamiento), Meta (Instagram), Unipile (correo y LinkedIn), OpenRouter
        (redacción de los mensajes), Apify (fuentes públicas de prospección) y
        Google Calendar a través de Composio (agendado de reuniones). No hay
        ninguna otra cesión.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Cuánto tiempo</h2>
      <p>
        Los datos de una cuenta de Instagram se conservan mientras esa cuenta
        siga conectada. Los datos de contacto profesional, mientras la relación
        comercial siga abierta. En ambos casos se eliminan antes si se solicita.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Tus derechos</h2>
      <p>
        Puedes pedir acceso, rectificación, supresión, limitación, portabilidad
        u oposición escribiendo a{" "}
        <a className="underline" href="mailto:enrique@thecotocompany.com">
          enrique@thecotocompany.com
        </a>
        . También puedes revocar el acceso de la app en cualquier momento desde
        Instagram, en Configuración → Apps y sitios web. Cómo pedir el borrado
        está detallado en{" "}
        <a className="underline" href="/legal/eliminar-datos">
          eliminación de datos
        </a>
        .
      </p>
    </>
  );
}
