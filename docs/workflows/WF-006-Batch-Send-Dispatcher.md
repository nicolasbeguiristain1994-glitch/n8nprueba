# Workflow Spec: WF-006 — Batch Send Dispatcher

> **Archivo n8n:** `n8n/workflow-specs/WF-006-Batch-Send-Dispatcher.json`
> **Estado:** Draft
> **Versión:** 1.0
> **Última actualización:** 2026-04-06

---

## Descripción

Orquesta el envío masivo de mensajes para una campaña. Consulta los contactos elegibles según el segmento objetivo de la campaña, itera sobre ellos y delega el envío individual al workflow WF-007 vía webhook. Actúa como dispatcher: no envía mensajes directamente, sino que distribuye la carga en llamadas atómicas y controladas.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook |
| Método | POST |
| Path | `/webhook/batch-send` |

---

## Input esperado

```json
{
  "campaign_id": "uuid",
  "dry_run": false
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `campaign_id` | UUID | Sí | ID de la campaña en tabla `campaigns` |
| `dry_run` | Boolean | No | Si `true`, ejecuta sin enviar mensajes (default: `false`) |

---

## Nodos n8n

| # | Nodo | Tipo | Descripción |
|---|------|------|-------------|
| 1 | Webhook | `n8n-nodes-base.webhook` | Recibe el POST con `campaign_id` |
| 2 | Postgres – Get Campaign | `n8n-nodes-base.postgres` | `SELECT` datos y estado de la campaña |
| 3 | IF – Campaign Valid | `n8n-nodes-base.if` | Verifica que `status = 'scheduled'` o `'running'` |
| 4 | Postgres – Get Contacts | `n8n-nodes-base.postgres` | `SELECT` contactos del segmento objetivo con `status = 'active'` |
| 5 | Split In Batches | `n8n-nodes-base.splitInBatches` | Divide en lotes de 50 para control de rate |
| 6 | HTTP Request – WF-007 | `n8n-nodes-base.httpRequest` | POST a `/webhook/send-whatsapp` por cada contacto |
| 7 | Postgres – Update Campaign | `n8n-nodes-base.postgres` | `UPDATE campaigns SET status = 'running'` al inicio |
| 8 | Postgres – Mark Completed | `n8n-nodes-base.postgres` | `UPDATE campaigns SET status = 'completed'` al finalizar |
| 9 | Postgres – Log Execution | `n8n-nodes-base.postgres` | `INSERT` en `workflow_runs` |
| 10 | Slack – Error Alert | `n8n-nodes-base.slack` | Alerta en caso de fallo crítico |

---

## Flujo paso a paso

1. Webhook recibe `POST /webhook/batch-send` con `campaign_id`
2. Consulta la campaña en `campaigns` — valida que exista y tenga `status` apto
3. Si la campaña no es válida, responde `400` con motivo y termina
4. Consulta los contactos elegibles según `target_segment` y `status = 'active'`
5. Actualiza `campaigns.status = 'running'`
6. Itera en lotes de 50 contactos con `Split In Batches`
7. Por cada contacto, hace POST a WF-007 con `{ phone, message, campaign_id, contact_id }`
8. Si `dry_run = true`, omite el paso 7 y solo loguea
9. Al terminar todos los lotes, actualiza `campaigns.status = 'completed'`
10. Registra la ejecución en `workflow_runs`

---

## Output

```json
{
  "campaign_id": "uuid",
  "contacts_total": 320,
  "dispatched": 318,
  "skipped": 2,
  "status": "completed"
}
```

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `campaigns` | SELECT + UPDATE (status) |
| `contacts` | SELECT (filtro por segmento y status) |
| `workflow_runs` | INSERT |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `CAMPAIGN_NOT_FOUND` | `campaign_id` no existe en DB | Responde `404`, termina |
| `CAMPAIGN_INVALID_STATUS` | Estado no es `scheduled` ni `running` | Responde `409`, termina sin modificar |
| `NO_CONTACTS_FOUND` | Segmento no retorna contactos | Log warning, marca campaña `completed`, termina |
| `WF007_HTTP_ERROR` | WF-007 responde `4xx` o `5xx` | Log del contacto fallido, continúa con el siguiente |
| `WF007_TIMEOUT` | WF-007 no responde en 10s | Reintento 1x; si falla, registra como `failed` y sigue |
| `DB_TIMEOUT` | Supabase no responde | Retry 3x con backoff; si persiste, alerta Slack y aborta |
| `RATE_LIMIT_EXCEEDED` | Evolution API devuelve 429 en WF-007 | El lote se pausa 5s entre iteraciones |
