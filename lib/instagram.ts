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
const GRAPH = "https://graph.instagram.com";

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
export async function canjearCodigo(
  code: string,
  redirectUri: string,
): Promise<TokenLargo> {
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
  const { access_token: tokenCorto, user_id: userId } = JSON.parse(
    textoCorta,
  ) as {
    access_token: string;
    user_id: number | string;
  };

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
    throw new InstagramError(
      `No se pudo alargar el token: ${larga.status} ${textoLarga.slice(0, 300)}`,
      larga.status,
      textoLarga,
    );
  }
  const { access_token, expires_in } = JSON.parse(textoLarga) as {
    access_token: string;
    expires_in: number;
  };

  return { access_token, user_id: String(userId), expires_in };
}

export type PerfilInstagram = { id: string; username: string };

/** Quién es la cuenta que acaba de autorizar. Sirve para saber a cuál guardarla. */
export async function quienEs(token: string): Promise<PerfilInstagram> {
  const res = await fetch(
    `${GRAPH}/v23.0/me?${new URLSearchParams({ fields: "id,username", access_token: token })}`,
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
