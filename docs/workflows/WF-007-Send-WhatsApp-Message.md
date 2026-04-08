# Workflow Spec: WF-007 — Send WhatsApp Message

> **Archivo n8n:** `n8n/workflow-specs/WF-007-Send-WhatsApp-Messege.json`
> **Estado:** Activo
> **Versión:** 1.0
> **Última actualización:** 2026-04-06

---

## Descripción

Envía un único mensaje de texto por WhatsApp usando la Evolution API. Es el workflow atómico de envío: recibe un número y un texto vía webhook, hace el POST a Evolution y registra el resultado en `outbound_messages`. Puede ser invocado directamente o como subworkflow desde WF-006.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook |
| Método | POST |
| Path | `/webhook/send-whatsapp` |
| Webhook ID | `957182ce-60c8-49a7-92a3-8e08602e5f62` |

---

## Input esperado

```json
{
  "phone": "+5491112345678",
  "message": "Hola {{nombre}}, tu mensaje aquí."
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `phone` | String | Sí | Número en formato E.164 |
| `message` | String | Sí | Texto del mensaje ya renderizado (sin variables) |

> **Nota:** el mensaje debe llegar con las variables ya sustituidas. Este workflow no aplica templates.

---

## Nodos n8n

| # | Nodo | Tipo | Descripción |
|---|------|------|-------------|
| 1 | Webhook | `n8n-nodes-base.webhook` | Recibe POST en `/webhook/send-whatsapp` |
| 2 | HTTP Request | `n8n-nodes-base.httpRequest` | POST a Evolution API — `sendText` en instancia `whatsapp-prod` |
| 3 | Insert rows in a table | `n8n-nodes-base.postgres` | `UPDATE outbound_messages SET status = 'sent', body = mensaje` |

**Credenciales utilizadas:**
- `Header Auth account` (ID: `V8WM8QJb690a2dcm`) — API key de Evolution
- `Postgres account` (ID: `xEGqwiZXpd5tMF9C`) — conexión a Supabase

---

## Flujo paso a paso

1. Webhook recibe `POST /webhook/send-whatsapp` con `phone` y `message`
2. HTTP Request hace `POST` a Evolution API:
   ```
   POST https://evolution-api-production-ec6b.up.railway.app/message/sendText/whatsapp-prod
   { "number": "<phone>", "text": "<message>" }
   ```
3. Postgres actualiza `outbound_messages`:
   - `body` = mensaje enviado
   - `status` = `'sent'`

---

## Output

Respuesta del webhook al caller:

```json
{
  "key": {
    "remoteJid": "5491112345678@s.whatsapp.net",
    "id": "EVOLUTION_MSG_ID"
  },
  "status": "PENDING"
}
```

La tabla `outbound_messages` queda con `status = 'sent'` y el cuerpo del mensaje registrado.

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `outbound_messages` | UPDATE (`body`, `status`) |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `MISSING_PHONE` | Campo `phone` ausente en el body | Evolution API devuelve error; el nodo Postgres no se ejecuta |
| `MISSING_MESSAGE` | Campo `message` ausente | Igual que el anterior |
| `PHONE_INVALID_FORMAT` | Número no válido para WhatsApp | Evolution API devuelve `400`; el registro en DB queda sin actualizar |
| `EVOLUTION_API_401` | API key incorrecta o vencida | Error en nodo HTTP Request; sin registro en DB |
| `EVOLUTION_API_429` | Rate limit de Evolution | n8n muestra ejecución fallida; sin reintento automático en esta versión |
| `EVOLUTION_API_500` | Error interno de Evolution | Ídem — sin reintento automático en esta versión |
| `DB_WRITE_ERROR` | Fallo al actualizar `outbound_messages` | El mensaje se envió pero queda sin registro — inconsistencia a monitorear |
| `WEBHOOK_TIMEOUT` | El caller no recibe respuesta en tiempo | n8n ejecuta igual; el caller debe manejar su propio timeout |

> **Deuda técnica conocida:** el workflow actual no tiene rama de error explícita. Si falla el HTTP Request, la ejecución se marca como error en n8n pero no hay alerta ni fallback. Se recomienda agregar nodo de error handling en v1.1.

---

## Historial de cambios

| Versión | Fecha | Cambio |
|---------|-------|--------|
| 1.0 | 2026-04-06 | Documentación inicial basada en JSON exportado de n8n |
