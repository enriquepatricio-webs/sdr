# SDR autónomo

Prospecta en frío por LinkedIn, Instagram y email, cualifica contra un ICP, y si
encaja agenda la reunión y te avisa por Telegram.

**En producción:** https://sdr.thecotocompany.com
**Workflows:** [W1](https://n8n.thecotocompany.com/workflow/kWxzVjy2O76lDyUf) ·
[W2](https://n8n.thecotocompany.com/workflow/00iDu1uIfnDPWkTa) ·
[W3](https://n8n.thecotocompany.com/workflow/QwOqOgknEZESgMKq)

La inteligencia de ventas no está en el código: vive en la base de datos y se
edita desde `/playbook`. El agente la lee en cada ejecución.

---

## Cómo está montado

```
Dashboard (Next.js en Vercel)  ←─ HTTP ─→  n8n self-hosted
        │                                        │
     Neon (Postgres)                    Unipile · Composio · OpenRouter
```

n8n **nunca** habla con la base de datos ni con Unipile directamente. Todo pasa
por la API del dashboard. No es purismo: es dónde viven las reglas que impiden
que te bloqueen una cuenta o que un prospecto reciba el mismo mensaje dos veces.
Un workflow se edita en un panel web sin revisión ni pruebas; un endpoint no.

### Las tres reglas que no se tocan

1. **Un mensaje se registra ANTES de enviarse.** `/api/messages/send` crea el
   toque como borrador, envía, y luego lo confirma. Si el envío falla queda en
   `fallido` y **no se reintenta**: pudo salir y haber fallado solo la
   confirmación, y reintentar duplicaría el mensaje.
2. **El webhook de Unipile puede llegar dos veces.** Se deduplica por
   `unipile_message_id` con un índice único. Y los mensajes propios vuelven por
   ese mismo webhook: sin descartarlos, el agente se responde a sí mismo en bucle.
3. **El cupo de envío no depende de cuántos leads haya.** Está en
   [lib/quota.ts](lib/quota.ts), es función pura y tiene sus propias pruebas.

---

## Puesta en marcha

### 1. Base de datos

```bash
npm install
cp .env.example .env.local
```

Rellena `.env.local`. Dos detalles que muerden:

- `DATABASE_URL` es la **pooled** (el host lleva `-pooler`). La usa la app.
- `DATABASE_URL_UNPOOLED` es la **directa**. La necesitan las migraciones:
  PgBouncer en modo transacción rompe el DDL con estado de sesión.

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

El seed deja un playbook, un ICP, dos cuentas de ejemplo en pausa, una campaña en
borrador y tres leads. **Autopiloto apagado.**

### 2. Vercel

```bash
vercel integration add neon
```

Elige *Link Existing Neon Account*. Inyecta `DATABASE_URL` y
`DATABASE_URL_UNPOOLED` con esos nombres exactos.

El resto no tienen integración de Marketplace, van a mano:

```bash
vercel env add OPENROUTER_API_KEY production
vercel env add UNIPILE_API_KEY production
vercel env add UNIPILE_DSN production
vercel env add COMPOSIO_API_KEY production
vercel env add APIFY_TOKEN production
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add DASHBOARD_PASSWORD production
vercel env add N8N_SHARED_SECRET production
```

Para el secreto de sesión, sin que pase por tu historial de shell:

```bash
openssl rand -base64 32 | vercel env add SESSION_SECRET production
```

`NEXT_PUBLIC_APP_URL` es la única que puede llevar ese prefijo: Next inlinea las
`NEXT_PUBLIC_*` en el bundle del navegador. Marcarla como sensible en Vercel **no**
la protege.

### 3. n8n

Los tres workflows ya están creados en n8n (ver [n8n/LEEME.md](n8n/LEEME.md)).
Falta una sola cosa:

1. n8n → Credentials → New → **Header Auth**, nombre exacto
   `SDR API (x-api-key)`, header `x-api-key`, valor tu `N8N_SHARED_SECRET`.
   Sin ella todos los nodos HTTP dan 401.
2. En `SDR · 2 · Conversación entrante`, copia la URL del webhook
   (`/webhook/sdr-unipile-inbound`) y regístrala en Unipile como webhook de
   mensajes nuevos.
3. Activa los tres workflows.

La credencial de OpenRouter ya está enlazada.

**Ojo con el dominio:** el proyecto tiene Vercel Authentication en modo
`all_except_custom_domains`, así que las URLs `*.vercel.app` están detrás del
SSO y devuelven un 302 a n8n. Por eso la API vive en `sdr.thecotocompany.com`,
que es dominio propio y queda fuera del SSO. Si algún día cambias de dominio,
tiene que ser otro dominio propio, no una URL de Vercel.

| Workflow | Cuándo corre | Qué hace |
|---|---|---|
| `sdr-outbound` | cada 30 min | Rellena la cola si hace falta, coge el lote que autorice la API, redacta el primer toque y envía. Espera 40-180 s aleatorios entre leads. |
| `sdr-inbound` | webhook de Unipile | El principal. Descarta ecos y duplicados, carga el hilo y suelta al agente con sus seis herramientas. |
| `sdr-followup` | 10:00 de L a V | Seguimientos vencidos, con el hilo previo delante para no repetirse. |

### 4. Lo que falta por rellenar

| Variable | Estado | Por qué |
|---|---|---|
| `UNIPILE_DSN` | **falta** | Está guardada como `NIPILE_DSN` (errata). Como es sensible, su valor no se puede leer para copiarlo: hay que volver a introducirlo. |
| `DASHBOARD_PASSWORD` | **falta** | La eliges tú. Sin ella el login del dashboard da 500. |
| `TELEGRAM_CHAT_ID` | opcional | Se puede poner desde `/settings` en vez de como variable. |

```bash
vercel env rm NIPILE_DSN production --yes
vercel env add UNIPILE_DSN production      # te lo pide por teclado
vercel env add DASHBOARD_PASSWORD production
vercel --prod                              # para que el redespliegue las coja
```

Nada de esto bloquea a n8n: el agente ya funciona con el autopiloto apagado.
`UNIPILE_DSN` solo hace falta cuando enciendas el autopiloto y empiece a enviar
de verdad.

### 5. Encender

En este orden, y no antes:

1. **Ajustes** → conecta las cuentas de Unipile y ponlas en `activa`.
   En Instagram deja el tope por hora: admite 100 acciones al día pero **no más
   de 10 por hora**, y 100 seguidas es justo el patrón que detecta el antifraude.
2. **Playbook** → edítalo y dale a **Probar** hasta que te guste cómo responde.
   Esto no envía nada a nadie.
3. **Campañas** → asigna cuenta, playbook e ICP, y activa.
4. **Ajustes** → enciende el autopiloto. A partir de aquí los mensajes salen
   solos.

---

## Las pantallas

| Ruta | Para qué |
|---|---|
| `/` | KPIs, embudo y **Parar todo** |
| `/playbook` | El entrenamiento de ventas. Versionado, con botón Probar |
| `/icp` | A quién buscas y a quién descartas |
| `/prospectar` | Buscar prospectos con IA vía Apify |
| `/campaigns` | Cuenta, topes, ventana de envío, activar y pausar |
| `/leads` | Pipeline, importador de CSV, hilo y **Intervenir** |
| `/meetings` | Reuniones agendadas |
| `/settings` | Cuentas, modelo, Telegram, autopiloto, reabastecimiento |

### Probar

En `/playbook` escribes lo que diría el prospecto y ves la respuesta del agente,
con su coste y su latencia. **No envía nada.** Es el mismo montaje de prompt que
usa n8n en producción: si fuera otro, estarías probando un agente distinto del
que escribe a la gente.

### Que no se pare nunca

Con el reabastecimiento encendido (`/settings`), cuando una campaña en marcha se
queda sin leads el sistema busca más él solo: traduce el ICP a filtros de Apify,
ejecuta, puntúa cada perfil y mete en la campaña los que pasan el umbral.

Cada búsqueda usa un **ángulo distinto** —otro sector, otra zona, otros cargos—
y se excluye a quien ya esté en el sistema. Si no, repetiría a la misma gente
gastando dinero.

Dos frenos:

- **Gasto**: tope de búsquedas automáticas al día.
- **Envío**: llenar la cola no autoriza ni un mensaje más. Diez mil leads
  producen los mismos 25 mensajes al día que diez.

Una campaña **pausada nunca se reabastece**. Si has echado el freno de mano, el
sistema no se rearma solo.

---

## Los frenos

| Freno | Dónde | Qué hace |
|---|---|---|
| **Parar todo** | `/` | Pausa todas las campañas y apaga el autopiloto. `/api/leads/next` se vacía al instante. Reanudar es campaña a campaña. |
| **Autopiloto** | `/settings` | Apagado, el agente redacta y deja el borrador en el hilo del lead. No sale nada. |
| **Intervenir** | `/leads/[id]` | Congela un lead. El agente deja de tocarlo y la API rechaza sus cambios. |
| **Topes** | `/settings` | Por cuenta y por hora. Máximo 80/día, imposible de superar: hay un CHECK en la base. |
| **Umbral** | `/playbook` | Sin score suficiente, `/api/calendar/book` devuelve 409 aunque el modelo lo intente. |

---

## Pruebas

```bash
npm run verify
```

Además, verificado contra el despliegue real:

| Comprobación | Resultado |
|---|---|
| `/` sin sesión | 307 al login |
| API sin credenciales | 401 |
| API con `x-api-key` mala | 401 |
| API con `x-api-key` buena | playbook activo, prompt de 14.157 caracteres |
| Botón Probar contra OpenRouter | respuesta real, 0,014 $, 5 s |
| W2 con un eco nuestro | detenido antes del agente |
| W2 con un webhook duplicado | detenido antes del agente |
| W1 | primer toque redactado con el playbook |
| W3 | seguimiento sin repetir el mensaje anterior |

| Suite | Qué cubre |
|---|---|
| `db:verify` | Migración y restricciones contra Postgres real (PGlite, sin Neon ni Docker) |
| `test:ventana` | Ventanas de envío y husos, incluidos los dos cambios de hora |
| `test:csv` | Lector RFC 4180, separador de Excel español, mapeo de columnas |
| `test:cupo` | Topes de envío por cuenta, campaña y hora |
| `test:reabastecer` | Cuándo buscar más leads y cuándo no |
| `test:integraciones` | Unipile y Composio contra respuestas simuladas |
| `test:n8n` | Los tres workflows: conexiones, herramientas y que nadie se salte la API |

---

## Fuera de alcance

- **No es un CRM.** El estado del lead vive en `leads` y punto.
- **No hay multiusuario.** Una contraseña, una persona.
- **El agente no aprende solo.** El playbook lo cambias tú. Es a propósito: un
  agente que reescribe sus propias instrucciones mientras escribe a desconocidos
  desde tu cuenta borra todo lo demás de esta lista.

## Aviso

Esto escribe a personas reales desde tus cuentas. El playbook trae por defecto
la regla de **no negar nunca que hay un asistente detrás** y de dar de baja a la
primera petición. Puedes cambiarlo; conviene que sea una decisión y no un
descuido.
