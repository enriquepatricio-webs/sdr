# Workflows de n8n

Los cuatro workflows **vivos** están en n8n, creados con el SDK oficial:

| Workflow | ID | Enlace |
|---|---|---|
| SDR · 1 · Primer toque en frío | `kWxzVjy2O76lDyUf` | https://n8n.thecotocompany.com/workflow/kWxzVjy2O76lDyUf |
| SDR · 2 · Conversación entrante | `00iDu1uIfnDPWkTa` | https://n8n.thecotocompany.com/workflow/00iDu1uIfnDPWkTa |
| SDR · 3 · Seguimiento | `QwOqOgknEZESgMKq` | https://n8n.thecotocompany.com/workflow/QwOqOgknEZESgMKq |
| SDR · 4 · Lead magnets de Instagram | `VVPpr7kjDFiwkn3o` | https://n8n.thecotocompany.com/workflow/VVPpr7kjDFiwkn3o |

Los `.json` de esta carpeta son un volcado literal de lo que hay guardado en
n8n, por si hay que reconstruirlos en otra instancia. Ya apuntan a
`sdr.thecotocompany.com`. Cuando se edita un workflow en n8n hay que volver a
volcarlos, o el repositorio dice una cosa y producción hace otra: ya pasó una
vez y el fichero se quedó dos versiones por detrás.

**Guardar no es publicar.** Un cambio guardado sigue sin ejecutarse en
producción hasta que se publica la versión. Los cuatro están publicados.

## Estado

Los cuatro están **activos**, con la credencial `SDR API (x-api-key)` enlazada en
todos los nodos HTTP y modelo `deepseek/deepseek-v4-flash`.

## W4 · Lead magnets

Cada 15 minutos llama a `POST /api/magnets/run`, que da una vuelta a todos los
imanes encendidos: comentarios nuevos → petición de follow → verificación →
entrega del recurso → propuesta de reunión.

El cron no marca el volumen: lo marca el tope horario de la cuenta de Instagram
(8/hora por defecto, y la plataforma bloquea por encima de 10). Llamarlo más a
menudo no envía más, solo comprueba antes si hay comentarios nuevos.

## El playbook se pide POR LEAD, no una vez

W1 y W3 lo pedían una sola vez al principio (`executeOnce`) y sin decir de qué
campaña. Con una sola empresa daba igual; con varias, el agente escribía a los
prospectos de un cliente con el contexto, la oferta y las lecciones de otro.

Ahora la llamada va dentro del bucle y lleva `campaign_id` y `lead_id`:

    /api/playbook/active?campaign_id=…&lead_id=…

`campaign_id` es lo que decide de qué empresa se habla; `lead_id` mete en el
prompt lo que se averiguó de esa persona en concreto. En W1 el orden es
`Enriquecer prospecto → Playbook activo → Redactar`, para que el resumen del
scraping esté hecho antes de montar el prompt.

El autopiloto NO se decide aquí. Lo aplica `/api/messages/send`, que es la
única puerta de salida, leyendo el de la empresa de esa campaña. Por eso una
empresa puede estar enviando mientras otra sigue acumulando borradores.

## Dos trampas que costaron encontrar

**El presupuesto de tokens.** `deepseek-v4-pro` razona en modo `high` por
defecto y los tokens de razonamiento salen del mismo presupuesto que la
respuesta. Con `maxTokens: 500` se lo gastaba entero razonando y devolvía
contenido **vacío** sin marcar error: la ejecución decía "success" y no se
escribía nada. Por eso los nodos van con 4.000 (W1, W3) y 8.000 (W2).

**El escapado del cuerpo JSON.** Los textos que escribe el agente se
interpolaban entre comillas dentro del `jsonBody`. Un salto de línea en el
mensaje —y los mensajes de ventas los llevan— producía JSON inválido y la
herramienta fallaba. Ahora cada texto pasa por `JSON.stringify`.

Relacionado: las seis herramientas llevan `neverError`, para que un 409
permanente llegue al agente como dato legible en vez de hacerle reintentar la
misma llamada hasta agotar las iteraciones.

## Qué se probó

Con datos simulados, ejecución real en n8n:

- **W2 · eco**: un mensaje enviado por nuestra propia cuenta se detecta y se
  descarta antes de invocar al agente. Sin esto, el agente se responde a sí
  mismo en bucle sobre un hilo con una persona real.
- **W2 · duplicado**: un webhook repetido se corta en el mismo sitio.
- **W1**: el agente redactó un primer toque real usando el playbook activo.
- **W3**: el agente redactó un seguimiento sin repetir el mensaje anterior.
- **W2 · conversación completa contra la API real**: ante «no me interesa», el
  agente cualificó (score 70, «es una objeción de timing, no un rechazo
  definitivo»), redactó la respuesta y el sistema la guardó como borrador sin
  enviar nada, porque el autopiloto está apagado.
