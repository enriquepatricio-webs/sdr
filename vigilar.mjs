/**
 * Avisa por Telegram si alguien lleva rato sin respuesta o hay errores.
 *
 * Vive en el servidor y no en el portatil de nadie: el vigilante anterior murio
 * cuando se limpio la carpeta donde estaba, y un vigilante que se muere en
 * silencio es peor que no tenerlo. Por eso ahora esta en el repositorio: vivia
 * suelto dentro de /opt/sdr, que es la copia de trabajo de git, asi que
 * cualquier clonado limpio se lo llevaba por delante.
 *
 * Lo lanza el temporizador sdr-vigilar.timer cada 15 minutos.
 */
import { neon } from "/opt/sdr/node_modules/@neondatabase/serverless/index.mjs";
const sql = neon(process.env.DATABASE_URL);
const avisos = [];
const avisados = [];

/**
 * Cada mensaje sin responder se avisa UNA vez.
 *
 * Antes se avisaba en cada vuelta mientras el mensaje siguiera sin respuesta:
 * el mismo texto cada quince minutos durante seis horas. Un fuera de oficina en
 * catalan llego a mandar ocho avisos identicos.
 *
 * Repetir no hace que se lea antes, hace que se silencie el canal. Y un canal
 * silenciado no avisa del que si importaba. Si hace falta insistir, que insista
 * una persona: para eso el aviso dice quien es.
 */
const sinRespuesta = await sql`
  select l.id, coalesce(l.instagram_username, l.full_name, l.email) as quien, c.channel,
    round(extract(epoch from (now() - u.cuando))/60) as min
  from leads l join campaigns c on c.id=l.campaign_id
  cross join lateral (
    select t.created_at as cuando, t.body from touches t
    where t.lead_id=l.id and t.direction='in' order by t.created_at desc limit 1) u
  where u.cuando between now() - interval '6 hours' and now() - interval '20 minutes'
    and l.status not in ('no_interesado','descartado','error')
    and not exists (select 1 from touches o where o.lead_id=l.id and o.direction='out'
      and o.status='enviado' and o.sent_at >= u.cuando)
    /**
     * No cuenta como "sin respuesta" un mensaje que esa persona YA habia
     * mandado palabra por palabra. Un texto identico repetido no lo escribe
     * una persona: es un autorespondedor o una cuenta con su propio bot
     * repitiendo su guion.
     */
    and not exists (select 1 from touches r where r.lead_id=l.id and r.direction='in'
      and r.body = u.body and r.created_at < u.cuando)
    and not exists (select 1 from run_logs g where g.lead_id=l.id
      and g.workflow='vigilante' and g.created_at >= u.cuando)`;

for (const p of sinRespuesta) {
  avisos.push(`Sin respuesta hace ${p.min} min: ${p.quien} (${p.channel})`);
  avisados.push(p.id);
}

/**
 * Solo los errores de verdad. Un 422 de LinkedIn que el codigo ya sabe manejar
 * se registra como aviso, no como error, precisamente para no llegar hasta aqui.
 */
for (const e of await sql`select workflow, left(message,110) as m, count(*)::int as n
  from run_logs where level='error' and created_at > now() - interval '15 minutes' group by 1,2`)
  avisos.push(`Error x${e.n} en ${e.workflow}: ${e.m}`);

if (!avisos.length) process.exit(0);

const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: "SDR necesita que le mires:\n\n" + avisos.join("\n"),
  }),
});

/**
 * La marca se pone DESPUES de que Telegram acepte el mensaje. Al reves, un fallo
 * de red dejaria el aviso por dado y nadie se enteraria nunca de ese lead.
 */
if (r.ok) {
  for (const id of avisados) {
    await sql`insert into run_logs (workflow, lead_id, level, message)
      values ('vigilante', ${id}, 'info', 'Avisado por Telegram: sigue sin respuesta.')`;
  }
} else {
  console.error(`Telegram respondio ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
