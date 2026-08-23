# Workflows de n8n

Los tres workflows **vivos** están en n8n, creados con el SDK oficial:

| Workflow | ID | Enlace |
|---|---|---|
| SDR · 1 · Primer toque en frío | `kWxzVjy2O76lDyUf` | https://n8n.thecotocompany.com/workflow/kWxzVjy2O76lDyUf |
| SDR · 2 · Conversación entrante | `00iDu1uIfnDPWkTa` | https://n8n.thecotocompany.com/workflow/00iDu1uIfnDPWkTa |
| SDR · 3 · Seguimiento | `QwOqOgknEZESgMKq` | https://n8n.thecotocompany.com/workflow/QwOqOgknEZESgMKq |

Los `.json` de esta carpeta son la versión de referencia importable, por si hay
que reconstruirlos en otra instancia. Ya apuntan a `sdr.thecotocompany.com`.

## Estado

Los tres están **activos**, con la credencial `SDR API (x-api-key)` enlazada en
todos los nodos HTTP y modelo `deepseek/deepseek-v4-flash`.

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
