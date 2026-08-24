/**
 * Pruebas del imán de Instagram. `npm run test:imanes`.
 *
 * Se prueban las tres cosas que, si fallan, le escriben a quien no toca: la
 * detección de la palabra clave, las transiciones de estado y que el mismo
 * comentario no genere dos contactos.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMENTARIOS_POR_RELECTURA,
  NUDGE_MAX_MINUTOS,
  NUDGE_MIN_MINUTOS,
  COMENTARIOS_PRIMERA_LECTURA,
  MAX_PETICIONES_DE_FOLLOW,
  PASO_DE_ESTADO,
  PASO_RECORDATORIO,
  RECORDATORIO_FOLLOW,
  SEGUIDORES_FRESCOS_MIN,
  SEGUIDORES_FRESCOS_SI_CONTESTAN_MIN,
  TRANSICIONES,
  comentariosConLaClave,
  minutosEntreLecturas,
  minutosHastaElNudge,
  mencionaClave,
  normalizar,
  normalizarUsuario,
  pideQueLeDejen,
  puedeTransicionar,
  type EstadoIman,
} from "./magnets";
import { MENCIONA_DINERO, sinCifrasDeDinero } from "./sin-precios";

/* ---- Palabra clave ------------------------------------------------------ */

test("la palabra suelta cuenta", () => {
  assert.equal(mencionaClave("GUIA", "guia"), true);
  assert.equal(mencionaClave("guia", "GUIA"), true);
});

test("los acentos no importan, en ninguna de las dos direcciones", () => {
  assert.equal(mencionaClave("quiero la GUÍA", "guia"), true);
  assert.equal(mencionaClave("quiero la guia", "GUÍA"), true);
  assert.equal(mencionaClave("mándame el MÉTODO", "metodo"), true);
});

test("la palabra dentro de una frase cuenta", () => {
  assert.equal(mencionaClave("Hola! me mandas la guia porfa?", "guia"), true);
  assert.equal(mencionaClave("guia, gracias", "guia"), true);
  assert.equal(mencionaClave("quiero la guia.", "guia"), true);
});

test("con emojis y almohadillas pegadas también", () => {
  assert.equal(mencionaClave("🔥GUIA🔥", "guia"), true);
  assert.equal(mencionaClave("#guia", "guia"), true);
  assert.equal(mencionaClave("@ana guia", "guia"), true);
});

test("no cuenta si es parte de otra palabra", () => {
  // Quien escribe "guiado" no ha pedido nada, y escribirle sería spam.
  assert.equal(mencionaClave("me has guiado muy bien", "guia"), false);
  assert.equal(mencionaClave("aguia", "guia"), false);
});

test("un comentario sin la palabra no cuenta", () => {
  assert.equal(mencionaClave("qué bueno el video", "guia"), false);
  assert.equal(mencionaClave("", "guia"), false);
});

test("una clave de varias palabras funciona", () => {
  assert.equal(mencionaClave("quiero el PLAN 90 ya", "plan 90"), true);
  assert.equal(mencionaClave("quiero el plan", "plan 90"), false);
});

test("una clave vacía no detecta a nadie", () => {
  // Si no, un imán mal configurado escribiría a TODOS los comentaristas.
  assert.equal(mencionaClave("lo que sea", ""), false);
  assert.equal(mencionaClave("lo que sea", "   "), false);
});

test("normalizar quita acentos y baja a minúsculas", () => {
  assert.equal(normalizar("ÁÉÍÓÚ Ñ"), "aeiou n");
});

test("el usuario se guarda sin arroba y en minúsculas", () => {
  assert.equal(normalizarUsuario("  @Ana_G "), "ana_g");
  assert.equal(normalizarUsuario("ANA"), "ana");
});

/* ---- Un comentario, un contacto ----------------------------------------- */

const COMENTARIOS = [
  {
    id: "c1",
    text: "GUIA",
    ownerUsername: "Ana",
    owner: { full_name: "Ana G" },
  },
  { id: "c2", text: "guia porfa!!", ownerUsername: "@ana" },
  { id: "c3", text: "guía", ownerUsername: "ANA" },
  { id: "c4", text: "qué crack", ownerUsername: "beto" },
  { id: "c5", text: "me mandas la guia?", ownerUsername: "carla" },
];

test("la misma persona comentando tres veces es UN contacto", () => {
  const r = comentariosConLaClave(COMENTARIOS, "guia");
  assert.equal(r.length, 2);
  assert.deepEqual(
    r.map((c) => c.username),
    ["ana", "carla"],
  );
});

test("gana el primer comentario de esa persona, con su nombre", () => {
  const r = comentariosConLaClave(COMENTARIOS, "guia");
  assert.equal(r[0].commentId, "c1");
  assert.equal(r[0].fullName, "Ana G");
});

test("quien no dijo la palabra no entra", () => {
  const r = comentariosConLaClave(COMENTARIOS, "guia");
  assert.ok(!r.some((c) => c.username === "beto"));
});

test("un comentario sin autor se ignora en vez de romper", () => {
  const r = comentariosConLaClave([{ id: "x", text: "guia" }], "guia");
  assert.equal(r.length, 0);
});

/* ---- Máquina de estados -------------------------------------------------- */

const VALIDAS: [EstadoIman, EstadoIman][] = [
  ["detectado", "pidiendo_follow"],
  ["pidiendo_follow", "verificado"],
  ["verificado", "entregado"],
  ["entregado", "en_conversacion"],
];

test("el embudo avanza paso a paso", () => {
  for (const [desde, hasta] of VALIDAS) {
    assert.equal(
      puedeTransicionar(desde, hasta),
      true,
      `${desde} → ${hasta} debería valer`,
    );
  }
});

test("desde cualquier estado vivo se puede descartar", () => {
  for (const desde of [
    "detectado",
    "pidiendo_follow",
    "verificado",
    "entregado",
    "en_conversacion",
  ] as const) {
    assert.equal(puedeTransicionar(desde, "descartado"), true, desde);
  }
});

test("NO se entrega a quien no se ha verificado", () => {
  assert.equal(puedeTransicionar("detectado", "entregado"), false);
  assert.equal(puedeTransicionar("pidiendo_follow", "entregado"), false);
});

test("NO se verifica a quien no ha recibido la petición", () => {
  assert.equal(puedeTransicionar("detectado", "verificado"), false);
});

test("no se vuelve atrás", () => {
  assert.equal(puedeTransicionar("entregado", "verificado"), false);
  assert.equal(puedeTransicionar("pidiendo_follow", "detectado"), false);
  assert.equal(puedeTransicionar("en_conversacion", "entregado"), false);
});

test("descartado es terminal: no se le vuelve a escribir nunca", () => {
  for (const hasta of Object.keys(TRANSICIONES) as EstadoIman[]) {
    assert.equal(
      puedeTransicionar("descartado", hasta),
      false,
      `descartado → ${hasta}`,
    );
  }
});

test("ningún estado se transiciona a sí mismo", () => {
  for (const estado of Object.keys(TRANSICIONES) as EstadoIman[]) {
    assert.equal(puedeTransicionar(estado, estado), false, estado);
  }
});

/* ---- Frenos -------------------------------------------------------------- */

test('"no me escribas" para el embudo', () => {
  assert.equal(pideQueLeDejen("por favor no me escribas más"), true);
  assert.equal(pideQueLeDejen("DEJAME EN PAZ"), true);
  assert.equal(pideQueLeDejen("déjame en paz"), true);
  assert.equal(pideQueLeDejen("esto es spam"), true);
  assert.equal(pideQueLeDejen("gracias, me lo miro"), false);
});

test("el recordatorio del follow sale una sola vez y sin dinero", () => {
  // Es un texto fijo que va a mucha gente: si algún día alguien mete una cifra
  // ahí, el filtro de salida lo bloquea y el contacto se queda sin nada.
  assert.equal(MENCIONA_DINERO.test(RECORDATORIO_FOLLOW), false);

  // La petición inicial cuenta como una. Con el tope en dos, queda UN
  // recordatorio: a la tercera ya no es recordar, es insistir.
  assert.equal(MAX_PETICIONES_DE_FOLLOW, 2);
  const trasLaPeticionInicial = 1;
  assert.ok(trasLaPeticionInicial < MAX_PETICIONES_DE_FOLLOW);
  assert.ok(trasLaPeticionInicial + 1 >= MAX_PETICIONES_DE_FOLLOW);

  // Y su paso no puede pisar a ninguno de los tres del embudo, o el
  // deduplicador daría el recurso por entregado sin haberlo mandado.
  assert.ok(
    !Object.values(PASO_DE_ESTADO).includes(PASO_RECORDATORIO as never),
  );
});

test("se lee deprisa cuando el post es nuevo y se afloja despues", () => {
  const ahora = new Date("2026-08-24T18:00:00Z");
  const hace = (h: number) => new Date(ahora.getTime() - h * 3_600_000);

  // Las primeras horas es cuando llega casi todo el mundo.
  assert.equal(minutosEntreLecturas(hace(0), ahora), 2);
  assert.equal(minutosEntreLecturas(hace(5), ahora), 2);
  // Despues ya no compensa pagar un scraping cada dos minutos.
  assert.equal(minutosEntreLecturas(hace(7), ahora), 15);
  assert.equal(minutosEntreLecturas(hace(60), ahora), 60);

  // Nunca cero: eso seria leer en cada vuelta del cron pase lo que pase.
  for (const h of [0, 6, 48, 500]) {
    assert.ok(minutosEntreLecturas(hace(h), ahora) > 0);
  }

  // Y la relectura tiene que pedir bastante menos que la primera, o el coste
  // vuelve a crecer con el tamaño del post en cada vuelta.
  assert.ok(COMENTARIOS_POR_RELECTURA < COMENTARIOS_PRIMERA_LECTURA);
});

test("el rato hasta el «que tal» es fijo por persona y distinto entre personas", () => {
  // Si se sorteara en cada vuelta, el plazo cambiaria cada dos minutos y en
  // cuanto saliera un numero bajo se mandaria antes de tiempo.
  const a = minutosHastaElNudge("11111111-1111-1111-1111-111111111111");
  assert.equal(a, minutosHastaElNudge("11111111-1111-1111-1111-111111111111"));

  // Y no puede ser el mismo para todos, que es lo que convierte una
  // conversacion en un envio masivo.
  const ids = Array.from(
    { length: 40 },
    (_, i) => `contacto-${i}-abcdefghijklmnop`,
  );
  const distintos = new Set(ids.map(minutosHastaElNudge));
  assert.ok(distintos.size > 5, `solo ${distintos.size} plazos distintos`);

  for (const id of ids) {
    const m = minutosHastaElNudge(id);
    assert.ok(m >= NUDGE_MIN_MINUTOS && m <= NUDGE_MAX_MINUTOS, `${id}: ${m}`);
  }

  // Preguntar "que te ha parecido" a los dos minutos delata al robot.
  assert.ok(NUDGE_MIN_MINUTOS >= 30);
});

test("a quien contesta se le mira la lista de seguidores de verdad", () => {
  // Seis horas de caché son un ahorro sensato para quien no ha dicho nada, y
  // una promesa rota para quien acaba de escribir "ya está" esperando algo
  // que le hemos prometido "ahora mismo".
  assert.ok(SEGUIDORES_FRESCOS_SI_CONTESTAN_MIN < SEGUIDORES_FRESCOS_MIN);
  assert.ok(SEGUIDORES_FRESCOS_SI_CONTESTAN_MIN >= 1);
});

test("los textos del imán no pueden llevar cifras de dinero", () => {
  assert.equal(MENCIONA_DINERO.test("te lo dejo en 300€"), true);
  assert.equal(MENCIONA_DINERO.test("cuesta 50 dolares"), true);
  assert.equal(MENCIONA_DINERO.test("te mando la guía por DM"), false);

  // Y el saneador que quita las cifras ANTES de que el modelo las vea: el
  // contexto sale de scrapear la web de la empresa, y las webs llevan tarifas.
  assert.equal(
    sinCifrasDeDinero("desde 700€ al mes"),
    "desde (importe omitido) al mes",
  );
  assert.equal(
    sinCifrasDeDinero("invierte +1.000€/mes"),
    "invierte +(importe omitido)/mes",
  );
  assert.equal(
    sinCifrasDeDinero("cuesta $1,200 USD"),
    "cuesta (importe omitido) USD",
  );
  assert.equal(sinCifrasDeDinero("unos 50 dolares"), "unos (importe omitido)");
  // Lo que NO es dinero se queda intacto.
  assert.equal(
    sinCifrasDeDinero("20 mesas y 5 empleados"),
    "20 mesas y 5 empleados",
  );
  assert.equal(sinCifrasDeDinero("abrimos a las 16:00"), "abrimos a las 16:00");
});
