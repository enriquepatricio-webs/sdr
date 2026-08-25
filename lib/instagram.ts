/**
 * Instagram por la API oficial de Meta.
 *
 * Sustituye a Unipile (los DMs) y a Apify (los comentarios y los seguidores).
 * La diferencia que importa no es técnica: Meta AVISA cuando alguien comenta,
 * mientras que scrapear obliga a ir a preguntar cada pocos minutos y a pagar
 * cada pregunta. Eso es lo que separa contestar en segundos de contestar en
 * minutos.
 *
 * El producto "Instagram" dentro de una app de Meta tiene su PROPIO id y su
 * propia clave, distintos de los de la app padre. Confundirlos cuesta horas,
 * porque el error que devuelve Meta es el mismo que el de una clave inválida.
 */

const AUTORIZAR = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
/**
 * La versión va SIEMPRE en la ruta.
 *
 * Sin ella, `graph.instagram.com/access_token` se interpreta como el id de un
 * objeto llamado "access_token" y Meta responde "Unsupported request - method
 * type: get", que no se parece en nada al problema real.
 */
const GRAPH = "https://graph.instagram.com/v23.0";

/**
 * Lo mínimo para leer comentarios, responderlos y mandar mensajes privados.
 *
 * No se pide nada más: cada permiso extra es una pantalla más de advertencias
 * al autorizar y una razón más para que Meta rechace la revisión.
 */
export const PERMISOS = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
].join(",");

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "InstagramError";
  }
}

function config() {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId) throw new Error("Falta INSTAGRAM_APP_ID.");
  if (!appSecret) throw new Error("Falta INSTAGRAM_APP_SECRET.");
  return { appId, appSecret };
}

/** La URL a la que se manda a la persona para que autorice. */
export function urlDeAutorizacion(redirectUri: string, state: string): string {
  const { appId } = config();
  const p = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: PERMISOS,
    state,
  });
  return `${AUTORIZAR}?${p.toString()}`;
}

export type TokenLargo = {
  access_token: string;
  user_id: string;
  expires_in: number;
};

/**
 * Del código que devuelve Instagram al token de 60 días.
 *
 * Son DOS pasos y no uno: el primero da un token de una hora, y sin el segundo
 * la conexión se caería sola esa misma tarde sin que nadie entendiera por qué.
 */
export type Canje = TokenLargo & {
  /** Si se quedó en el token corto, por qué. null si se alargó bien. */
  sinAlargar: string | null;
  /** Lo que la cuenta concedió. Vacío = autorizó sin dar ningún permiso. */
  permisos: string[];
};

export async function canjearCodigo(
  code: string,
  redirectUri: string,
): Promise<Canje> {
  const { appId, appSecret } = config();

  const corta = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
    cache: "no-store",
  });
  const textoCorta = await corta.text();
  if (!corta.ok) {
    throw new InstagramError(
      `Instagram rechazó el código: ${corta.status} ${textoCorta.slice(0, 300)}`,
      corta.status,
      textoCorta,
    );
  }
  const {
    access_token: tokenCorto,
    user_id: userId,
    permissions,
  } = JSON.parse(textoCorta) as {
    access_token: string;
    user_id: number | string;
    /**
     * Lo que la cuenta ha concedido de verdad.
     *
     * Meta emite el token aunque no conceda NADA, y entonces cada lectura
     * responde "Unsupported request - method type: get", que suena a ruta mal
     * escrita y no a permiso ausente. Es el dato que distingue las dos cosas.
     */
    permissions?: string[] | string;
  };

  /**
   * Si no se puede alargar, se guarda el corto y se sigue.
   *
   * El token corto vale una hora, que es de sobra para comprobar que todo lo
   * demás funciona y para renovarlo después. Tirar la autorización entera
   * porque falló el segundo paso obliga a la persona a repetir el proceso sin
   * que nadie haya podido mirar qué token teníamos.
   */
  const concedidos = Array.isArray(permissions)
    ? permissions
    : typeof permissions === "string" && permissions
      ? permissions.split(",")
      : [];

  const larga = await fetch(
    `${GRAPH}/access_token?${new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: appSecret,
      access_token: tokenCorto,
    })}`,
    { cache: "no-store" },
  );
  const textoLarga = await larga.text();
  if (!larga.ok) {
    return {
      access_token: tokenCorto,
      user_id: String(userId),
      expires_in: 3600,
      sinAlargar: `${larga.status} ${textoLarga.slice(0, 300)}`,
      permisos: concedidos,
    };
  }
  const { access_token, expires_in } = JSON.parse(textoLarga) as {
    access_token: string;
    expires_in: number;
  };

  return {
    access_token,
    user_id: String(userId),
    expires_in,
    sinAlargar: null,
    permisos: concedidos,
  };
}

/**
 * Cuánto antes de caducar se renueva.
 *
 * Meta da 60 días y deja renovar cuantas veces haga falta, así que el token es
 * eterno mientras alguien lo renueve. Diez días de margen dan de sobra para que
 * una semana sin actividad —vacaciones, un puente— no mate la conexión.
 */
export const DIAS_PARA_RENOVAR = 10;

/**
 * Otros 60 días.
 *
 * Meta exige que el token tenga al menos 24 horas de vida para poder renovarlo,
 * así que renovar en cada uso sería tirar llamadas: solo se hace cuando queda
 * poco.
 */
export async function renovarToken(token: string): Promise<TokenLargo> {
  const res = await fetch(
    `${GRAPH}/refresh_access_token?${new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: token,
    })}`,
    { cache: "no-store" },
  );
  const texto = await res.text();
  if (!res.ok) {
    throw new InstagramError(
      `No se pudo renovar el token: ${res.status} ${texto.slice(0, 300)}`,
      res.status,
      texto,
    );
  }
  const { access_token, expires_in } = JSON.parse(texto) as {
    access_token: string;
    expires_in: number;
  };
  return { access_token, user_id: "", expires_in };
}

export type PerfilInstagram = { id: string; username: string };

/** Quién es la cuenta que acaba de autorizar. Sirve para saber a cuál guardarla. */
export async function quienEs(token: string): Promise<PerfilInstagram> {
  const res = await fetch(
    `${GRAPH}/me?${new URLSearchParams({ fields: "id,username", access_token: token })}`,
    { cache: "no-store" },
  );
  const texto = await res.text();
  if (!res.ok) {
    throw new InstagramError(
      `No se pudo leer el perfil: ${res.status} ${texto.slice(0, 300)}`,
      res.status,
      texto,
    );
  }
  return JSON.parse(texto) as PerfilInstagram;
}

/* -------------------------------------------------------------------------- */
/* Publicaciones y comentarios                                                 */
/* -------------------------------------------------------------------------- */

async function pedir<T>(
  ruta: string,
  token: string,
  init?: { method: string; body: unknown },
): Promise<T> {
  const separador = ruta.includes("?") ? "&" : "?";
  const res = await fetch(
    `${GRAPH}${ruta}${separador}access_token=${encodeURIComponent(token)}`,
    init
      ? {
          method: init.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(init.body),
          cache: "no-store",
        }
      : { cache: "no-store" },
  );
  const texto = await res.text();
  if (!res.ok) {
    throw new InstagramError(
      `Instagram respondió ${res.status}: ${texto.slice(0, 300)}`,
      res.status,
      texto,
    );
  }
  return (texto ? JSON.parse(texto) : {}) as T;
}

export type MediaInstagram = { id: string; permalink: string };

/** El código de un enlace de Instagram: lo que va tras /p/, /reel/ o /tv/. */
export function codigoDeUrl(url: string): string | null {
  return url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

/**
 * De la URL de un post o reel a su id interno.
 *
 * Meta no ofrece "dame el id de esta URL": hay que listar las publicaciones de
 * la cuenta y buscar la que coincide. Por eso se piden las últimas, no todas —
 * un imán siempre apunta a algo reciente.
 */
export async function mediaDeUrl(
  token: string,
  postUrl: string,
  limite = 50,
): Promise<string | null> {
  const { data } = await pedir<{ data: MediaInstagram[] }>(
    `/me/media?fields=id,permalink&limit=${limite}`,
    token,
  );
  /**
   * Se compara el CÓDIGO, no la URL entera.
   *
   * El mismo post es `/p/DcbdEOhjZSr/` para quien copia el enlace y
   * `/reel/DcbdEOhjZSr/` para Meta, así que comparar URLs no encontraba nada y
   * el error decía que la publicación no era de esa cuenta, que es mentira.
   * Por el código aguanta además el `/username/p/...`, los parámetros de
   * seguimiento y la barra final.
   */
  const buscado = codigoDeUrl(postUrl);
  if (!buscado) return null;
  return data.find((m) => codigoDeUrl(m.permalink) === buscado)?.id ?? null;
}

export type ComentarioInstagram = {
  id: string;
  text: string;
  timestamp: string;
  username?: string;
  from?: { id: string; username?: string };
};

/** Los comentarios de una publicación, los más nuevos primero. */
export async function comentariosDeMedia(
  token: string,
  mediaId: string,
  limite = 100,
): Promise<ComentarioInstagram[]> {
  const { data } = await pedir<{ data: ComentarioInstagram[] }>(
    `/${mediaId}/comments?fields=id,text,timestamp,username,from&limit=${limite}`,
    token,
  );
  return data ?? [];
}

/** Responde en público, colgando del comentario. */
export async function responderComentario(
  token: string,
  comentarioId: string,
  texto: string,
): Promise<{ id: string }> {
  return pedir<{ id: string }>(`/${comentarioId}/replies`, token, {
    method: "POST",
    body: { message: texto },
  });
}

/**
 * El mensaje privado a quien comentó.
 *
 * Es la primitiva que Meta permite explícitamente para esto: se responde AL
 * COMENTARIO, no a una persona, y por eso no hace falta que te haya escrito
 * antes. Vale hasta 7 días después del comentario.
 */
export async function mensajePrivadoAlComentario(
  token: string,
  _igUserId: string,
  comentarioId: string,
  texto: string,
): Promise<{ message_id?: string }> {
  // Por `/me` y no por el id: la cuenta tiene dos identificadores parecidos
  // —`id` y `user_id`, que se diferencian en un dígito— y equivocarse da un
  // error que no dice cuál era el bueno. `me` no admite esa duda.
  return pedir<{ message_id?: string }>(`/me/messages`, token, {
    method: "POST",
    body: {
      recipient: { comment_id: comentarioId },
      message: { text: texto },
    },
  });
}

/**
 * Suscribe la cuenta a los avisos de Meta.
 *
 * Configurar el webhook en la app NO basta: cada cuenta de Instagram tiene que
 * suscribirse por separado. Sin esto llegan los eventos de prueba de la consola
 * —que salen de la app— y ninguno real, que es exactamente lo que parecía un
 * webhook roto.
 */
export async function suscribirCuenta(
  token: string,
): Promise<{ success?: boolean }> {
  return pedir<{ success?: boolean }>(
    `/me/subscribed_apps?subscribed_fields=comments,messages`,
    token,
    { method: "POST", body: {} },
  );
}

/** A qué está suscrita la cuenta ahora mismo. */
export async function suscripciones(token: string): Promise<unknown> {
  return pedir(`/me/subscribed_apps`, token);
}

export type PerfilDeQuienEscribe = {
  id: string;
  username?: string;
  name?: string;
  /** Si esa persona sigue a la cuenta. Es lo que abre la puerta del recurso. */
  is_user_follow_business?: boolean;
  is_business_follow_user?: boolean;
};

/**
 * Quién es quien te escribe, y si te sigue.
 *
 * Solo funciona DESPUÉS de que esa persona te haya escrito: mientras solo haya
 * comentado, Meta responde 230 "User consent is required to access user
 * profile". Su primer mensaje es el consentimiento.
 *
 * Por eso el embudo pide el follow por privado y comprueba cuando contestan, y
 * no al revés: antes de que escriban, esta pregunta no se puede hacer.
 */
export async function perfilDeQuienEscribe(
  token: string,
  igsid: string,
): Promise<PerfilDeQuienEscribe> {
  return pedir<PerfilDeQuienEscribe>(
    `/${igsid}?fields=name,username,is_user_follow_business,is_business_follow_user`,
    token,
  );
}

/** Mensaje dentro de una conversación ya abierta, por el id de la persona. */
export async function mensajeDirecto(
  token: string,
  _igUserId: string,
  destinatarioId: string,
  texto: string,
): Promise<{ message_id?: string }> {
  return pedir<{ message_id?: string }>(`/me/messages`, token, {
    method: "POST",
    body: {
      recipient: { id: destinatarioId },
      message: { text: texto },
    },
  });
}
