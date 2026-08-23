# Workflows de n8n

Los tres workflows **vivos** están en n8n, creados con el SDK oficial:

| Workflow | ID | Enlace |
|---|---|---|
| SDR · 1 · Primer toque en frío | `kWxzVjy2O76lDyUf` | https://n8n.thecotocompany.com/workflow/kWxzVjy2O76lDyUf |
| SDR · 2 · Conversación entrante | `00iDu1uIfnDPWkTa` | https://n8n.thecotocompany.com/workflow/00iDu1uIfnDPWkTa |
| SDR · 3 · Seguimiento | `QwOqOgknEZESgMKq` | https://n8n.thecotocompany.com/workflow/QwOqOgknEZESgMKq |

Los `.json` de esta carpeta son la versión de referencia importable, por si hay
que reconstruirlos en otra instancia. Ya apuntan a `sdr.thecotocompany.com`.

## Antes de activarlos

Falta **una** credencial en n8n. Sin ella, todos los nodos HTTP dan 401:

1. n8n → Credentials → New → **Header Auth**
2. Nombre exacto: `SDR API (x-api-key)`
3. Name: `x-api-key`
4. Value: el `N8N_SHARED_SECRET` del proyecto de Vercel

La credencial de OpenRouter (`OpenRouter account`) ya está enlazada en los tres.

## Qué se probó

Con datos simulados, ejecución real en n8n:

- **W2 · eco**: un mensaje enviado por nuestra propia cuenta se detecta y se
  descarta antes de invocar al agente. Sin esto, el agente se responde a sí
  mismo en bucle sobre un hilo con una persona real.
- **W2 · duplicado**: un webhook repetido se corta en el mismo sitio.
- **W1**: el agente redactó un primer toque real usando el playbook activo.
- **W3**: el agente redactó un seguimiento sin repetir el mensaje anterior.
