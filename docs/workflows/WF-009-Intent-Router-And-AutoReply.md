# Workflow Spec: WF-009 — Intent Router & Auto Reply

> **Archivo n8n:** `n8n/workflow-specs/WF-009-intent-router.json`
> **Estado:** Draft
> **Versión:** 1.0
> **Última actualización:** 2026-04-06

---

## Descripción

Clasifica mensajes entrantes por intención (intent) usando detección de keywords y envía una respuesta automática personalizada vía Evolution API. Cubre cinco intents: `precios`, `info`, `horario`, `humano` (handoff a operador) y `generico` (fallback). Es invocado por WF-008 cuando llega un mensaje inbound, o puede triggerear directamente via webhook.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook |
| Método | POST |
| Path | `/webhook/wf009-intent-router` |
| Invocado por | WF-008 (Webhook Inbound WhatsApp) |

---

## Input esperado

```json
{
  "phone": "+5491112345678",
  "body": "Hola, quiero saber el precio",
  "inbound_message_id": "uuid-del-mensaje-original"
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `phone` | String | Sí | Número del contacto en formato E.164 |
| `body` | String | Sí | Texto del mensaje recibido |
| `inbound_message_id` | UUID | No | ID del registro en `inbound_messages` para trazabilidad |

---

## Intents y respuestas

### `precios` — keywords: `precio`, `costo`, `cuanto`, `cuánto`

```
💰 *Precios y planes*

Actualmente contamos con los siguientes planes:
• Plan Básico: consultanos para el precio actualizado
• Plan Pro: a medida según volumen
• Plan Enterprise: a convenir

Para recibir una cotización personalizada, respondé
con tu nombre y empresa. ¡Estaremos en contacto enseguida! 😊
```

### `info` — keywords: `info`, `información`, `informacion`, `qué es`, `que es`

```
📋 *¿Quiénes somos?*

Somos una plataforma de automatización de comunicaciones
vía WhatsApp para empresas en LATAM.

Automatizamos:
✅ Atención al cliente
✅ Notificaciones de transacciones
✅ Campañas de retención

¿Querés saber más? Escribí "precio" o pedí hablar con
un asesor escribiendo "asesor". 😊
```

### `horario` — keywords: `horario`, `cuando`, `cuándo`, `hora`

```
🕐 *Horarios de atención*

📅 Lunes a Viernes: 9:00 – 18:00 hs (ART)
📅 Sábados: 10:00 – 14:00 hs (ART)

Fuera de ese horario respondemos el primer día hábil.

¿Necesitás algo urgente? Escribí *"asesor"* y te
conectamos con alguien. 🙌
```

### `humano` — keywords: `humano`, `persona`, `asesor`

```
👤 *¡Enseguida te conectamos!*

Un asesor se va a comunicar con vos a la brevedad.

Horario de atención: Lunes a Viernes, 9:00 – 18:00 hs (ART).

Si es urgente también podés escribirnos a:
contacto@plataforma.com ✉️
```

> Además de la respuesta al contacto, este intent dispara una alerta al canal de Slack `#soporte-handoff` con el número de teléfono y el texto original.

### `generico` — cualquier otro mensaje

```
👋 ¡Hola! Recibimos tu mensaje.

Podemos ayudarte con:
• *precio*   – consultar planes y precios
• *info*     – conocer más sobre nosotros
• *horario*  – ver horarios de atención
• *asesor*   – hablar con una persona

¡Escribí la palabra que mejor describa tu consulta! 😊
```

---

## Nodos n8n

| # | Nodo | Tipo | Descripción |
|---|------|------|-------------|
| 1 | Webhook | `n8n-nodes-base.webhook` | Recibe POST con `phone`, `body`, `inbound_message_id` |
| 2 | Code – Classify Intent | `n8n-nodes-base.code` | JS que detecta keywords y asigna `intent` + `response_text` |
| 3 | HTTP Request – Evolution API | `n8n-nodes-base.httpRequest` | `POST /message/sendText/whatsapp-prod` con la respuesta |
| 4 | Postgres – Insert outbound | `n8n-nodes-base.postgres` | `INSERT` en `outbound_messages` con `status = 'sent'` |
| 5 | IF – Is Handoff | `n8n-nodes-base.if` | Verifica si `intent === 'humano'` |
| 6 | HTTP Request – Slack Alert | `n8n-nodes-base.httpRequest` | Notifica canal `#soporte-handoff` (solo rama `true`) |

---

## Flujo paso a paso

```
Webhook (POST /webhook/wf009-intent-router)
   ↓
Code – Classify Intent
   ├─ Normaliza body a minúsculas
   ├─ Evalúa regex por orden de prioridad:
   │    precio|costo|cuánto|cuanto   → intent = 'precios'
   │    info|información|qué es      → intent = 'info'
   │    horario|cuándo|hora          → intent = 'horario'
   │    humano|persona|asesor        → intent = 'humano'
   │    (default)                    → intent = 'generico'
   └─ Sets: { phone, intent, response_text, inbound_message_id }
   ↓
HTTP Request – Evolution API
   POST https://evolution-api-production-ec6b.up.railway.app
        /message/sendText/whatsapp-prod
   Body: { "number": "{{phone}}", "text": "{{response_text}}" }
   Auth: Header Auth (API key)
   ↓
Postgres – Insert outbound_messages
   INSERT INTO outbound_messages (phone, body, status, sent_at)
   VALUES (phone, response_text, 'sent', NOW())
   ↓
IF – Is Handoff
   ├─ true  (intent == 'humano')
   │    ↓
   │   HTTP Request – Slack Alert
   │   POST {{SLACK_WEBHOOK_URL}}
   │   Body: { "text": "🔔 Handoff solicitado\nTel: {{phone}}\nMensaje: {{body}}" }
   │
   └─ false (resto de intents)
        ↓
       (fin de flujo)
```

---

## Output

El webhook devuelve `200 OK` con el resultado de Evolution API. La tabla `outbound_messages` queda con el registro de la respuesta enviada.

```json
{
  "intent": "precios",
  "phone": "+5491112345678",
  "evolution_response": {
    "key": { "id": "EVOLUTION_MSG_ID" },
    "status": "PENDING"
  },
  "outbound_message_id": "uuid-del-registro-insertado"
}
```

---

## Tablas DB afectadas

| Tabla | Operación | Detalle |
|-------|-----------|---------|
| `inbound_messages` | (ninguna — solo lectura) | El registro ya fue creado por WF-008 |
| `outbound_messages` | INSERT | `phone`, `body` (= response_text), `status = 'sent'`, `sent_at` |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `MISSING_PHONE` | Campo `phone` ausente en el payload | El nodo HTTP falla; sin registro en DB. Webhook devuelve `400` |
| `MISSING_BODY` | Campo `body` ausente | Code node devuelve intent `generico` con `rawBody = ''` |
| `EVOLUTION_API_401` | API key incorrecta o vencida | Falla nodo HTTP Request; ejecución n8n en error |
| `EVOLUTION_API_429` | Rate limit de Evolution | Sin reintento automático en v1.0; ejecución en error |
| `EVOLUTION_API_500` | Error interno de Evolution | Sin reintento; log en n8n. Agregar retry en v1.1 |
| `DB_INSERT_FAILED` | Fallo en Postgres | El mensaje se envió pero no queda registrado — inconsistencia a monitorear |
| `SLACK_WEBHOOK_FAILED` | URL de Slack no configurada o caída | Solo afecta la rama `humano`; el mensaje al contacto ya fue enviado |
| `UNKNOWN_ENCODING` | Body con caracteres no-ASCII inesperados | Regex falla silenciosamente; cae en `generico` |

---

## Variables de entorno requeridas

| Variable | Descripción |
|----------|-------------|
| `EVOLUTION_API_URL` | `https://evolution-api-production-ec6b.up.railway.app` |
| `EVOLUTION_INSTANCE` | `whatsapp-prod` |
| `EVOLUTION_API_KEY` | API key (ya configurada como `Header Auth account` en n8n) |
| `SLACK_WEBHOOK_URL` | Webhook URL del canal `#soporte-handoff` (configurar antes de activar) |

---

## Deuda técnica / mejoras para v1.1

- Agregar retry automático (3x backoff) en el nodo Evolution
- Registrar también en `workflow_executions` para trazabilidad completa
- Reemplazar detección por keywords con un nodo LLM (Claude API) para intents más complejos
- Agregar rate limiting: no responder más de 1x por contacto en 5 minutos
- Lookup del contacto en `contacts` para personalizar la respuesta con `{{nombre}}`

---

## Historial de cambios

| Versión | Fecha | Cambio |
|---------|-------|--------|
| 1.0 | 2026-04-06 | Creación inicial |
