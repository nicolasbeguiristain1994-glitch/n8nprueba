# Workflow Spec: WF-008 — Webhook Inbound WhatsApp

> **Archivo n8n:** `n8n/workflow-specs/WF-008-Webhook-Inbound-WhatsApp.json`
> **Estado:** Draft
> **Versión:** 1.0
> **Última actualización:** 2026-04-06

---

## Descripción

Recibe y procesa los webhooks entrantes de la Evolution API. Cubre dos tipos de eventos:

1. **Mensajes inbound** — el contacto escribe al número de WhatsApp
2. **Status updates** — Evolution notifica cambios de estado de mensajes enviados (`delivered`, `read`, `failed`)

Para mensajes inbound, clasifica el texto, registra el mensaje en DB y lo rutea (FAQ automático, escalado a operador, o silencio). Para status updates, actualiza el registro correspondiente en `whatsapp_messages`.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook |
| Método | POST |
| Path | `/webhook/inbound-whatsapp` |

> Este endpoint debe ser configurado en Evolution API como destino de eventos (`MESSAGES_UPSERT` y `MESSAGES_UPDATE`).

---

## Input esperado

### Evento: mensaje inbound (`MESSAGES_UPSERT`)

```json
{
  "event": "MESSAGES_UPSERT",
  "instance": "whatsapp-prod",
  "data": {
    "key": {
      "remoteJid": "5491112345678@s.whatsapp.net",
      "fromMe": false,
      "id": "EVOLUTION_MSG_ID"
    },
    "message": {
      "conversation": "Hola, quiero info sobre mi depósito"
    },
    "messageTimestamp": 1712345678
  }
}
```

### Evento: status update (`MESSAGES_UPDATE`)

```json
{
  "event": "MESSAGES_UPDATE",
  "instance": "whatsapp-prod",
  "data": {
    "key": {
      "id": "EVOLUTION_MSG_ID",
      "remoteJid": "5491112345678@s.whatsapp.net",
      "fromMe": true
    },
    "update": {
      "status": "DELIVERY_ACK"
    }
  }
}
```

---

## Nodos n8n

| # | Nodo | Tipo | Descripción |
|---|------|------|-------------|
| 1 | Webhook | `n8n-nodes-base.webhook` | Recibe POST desde Evolution API |
| 2 | Switch – Event Type | `n8n-nodes-base.switch` | Bifurca entre `MESSAGES_UPSERT` y `MESSAGES_UPDATE` |
| 3 | IF – fromMe | `n8n-nodes-base.if` | Ignora mensajes enviados por el propio bot |
| 4 | Set – Normalize | `n8n-nodes-base.set` | Extrae `phone`, `body`, `evolution_message_id`, `timestamp` |
| 5 | Postgres – Find Contact | `n8n-nodes-base.postgres` | `SELECT` contacto por número de teléfono |
| 6 | Postgres – Log Inbound | `n8n-nodes-base.postgres` | `INSERT` en `whatsapp_messages` con `direction = 'inbound'` |
| 7 | Switch – Intent | `n8n-nodes-base.switch` | Clasifica texto: FAQ / soporte / ignorar |
| 8 | HTTP Request – WF-007 | `n8n-nodes-base.httpRequest` | Envía respuesta automática (si aplica) vía WF-007 |
| 9 | Postgres – Update Status | `n8n-nodes-base.postgres` | Para `MESSAGES_UPDATE`: `UPDATE whatsapp_messages SET status, delivered_at / read_at` |
| 10 | Postgres – Log Execution | `n8n-nodes-base.postgres` | `INSERT` en `workflow_runs` |

---

## Flujo paso a paso

### Rama A — Mensaje inbound (`MESSAGES_UPSERT`)

1. Webhook recibe el evento de Evolution
2. Switch verifica que sea `MESSAGES_UPSERT`
3. IF descarta si `fromMe = true` (bot hablando consigo mismo)
4. Set normaliza: extrae teléfono (strip `@s.whatsapp.net`), body, timestamp
5. Postgres busca el contacto por teléfono en `contacts`
6. Postgres inserta el mensaje en `whatsapp_messages` (`direction = 'inbound'`, `status = 'received'`)
7. Switch analiza el texto del mensaje:
   - Contiene palabra clave de FAQ → responde con mensaje automático vía WF-007
   - Contiene palabra de escalado ("operador", "humano", "ayuda") → alerta a Slack/operaciones
   - Otro → registra sin responder
8. Registra ejecución en `workflow_runs`

### Rama B — Status update (`MESSAGES_UPDATE`)

1. Webhook recibe el evento
2. Switch verifica que sea `MESSAGES_UPDATE`
3. Mapea el status de Evolution al interno:
   - `DELIVERY_ACK` → `delivered`
   - `READ` → `read`
   - `PLAYED` → `read`
   - `ERROR` → `failed`
4. Postgres: `UPDATE whatsapp_messages SET status = ?, delivered_at / read_at / failed_at = NOW() WHERE evolution_message_id = ?`
5. Registra ejecución en `workflow_runs`

---

## Output

El webhook responde `200 OK` inmediatamente en todos los casos (Evolution no reintenta si recibe 2xx).

```json
{ "received": true }
```

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `contacts` | SELECT (búsqueda por teléfono) |
| `whatsapp_messages` | INSERT (mensajes inbound) + UPDATE (status updates) |
| `workflow_runs` | INSERT |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `UNKNOWN_EVENT_TYPE` | Evolution envía un evento no mapeado | Log warning + responde `200` (no bloquear Evolution) |
| `CONTACT_NOT_FOUND` | Número no existe en `contacts` | Inserta el mensaje igualmente con `contact_id = NULL` |
| `DB_WRITE_ERROR` | Fallo al insertar en `whatsapp_messages` | Log error; responde `200` igual para no perder el webhook |
| `DB_UPDATE_NOT_FOUND` | `evolution_message_id` no existe en DB | Log warning (puede ser mensaje enviado fuera del sistema) |
| `WF007_CALL_FAILED` | Error al enviar respuesta automática | Log error; el mensaje inbound ya quedó registrado |
| `PAYLOAD_MALFORMED` | Evolution envía body inesperado | Switch no matchea ninguna rama; log + responde `200` |
| `SELF_MESSAGE_LOOP` | `fromMe = true` no filtrado | IF lo descarta antes de procesar |

---

## Notas de implementación

- Evolution debe tener configurado el webhook a este endpoint para los eventos `MESSAGES_UPSERT` y `MESSAGES_UPDATE`
- Responder siempre `200` para evitar reintentos de Evolution que generen duplicados
- La clasificación de intents (paso 7) es inicialmente por keywords; en fases futuras puede reemplazarse por un nodo LLM

---

## Historial de cambios

| Versión | Fecha | Cambio |
|---------|-------|--------|
| 1.0 | 2026-04-06 | Creación inicial |
