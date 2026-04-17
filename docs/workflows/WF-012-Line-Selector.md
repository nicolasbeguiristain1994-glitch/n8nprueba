# Workflow Spec: WF-012 — Line Selector

> **Archivo n8n:** `exports/WF-012-Line-Selector.json`
> **Estado:** Ready
> **Versión:** 1.0
> **Última actualización:** 2026-04-13

---

## Descripción

Sub-workflow que selecciona la línea WhatsApp óptima para un envío dado. Es llamado por WF-007 antes de cada mensaje. Evalúa disponibilidad, rate limit y región de las 30 líneas del pool, y retorna los datos de la instancia Evolution API a usar. Actúa como load balancer del pool de líneas.

No envía mensajes — solo decide **qué línea** los envía.

---

## Trigger

| Campo | Valor |
|-------|-------|
| Tipo | Webhook |
| Método | POST |
| Path | `/webhook/line-selector` |
| Llamado por | WF-007 (Send WhatsApp Message) |

---

## Input esperado

```json
{
  "region": "AR",
  "message_type": "campaign"
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `region` | string | No | Código ISO país: `AR`, `BR`, `MX`, `UY`. Si es `null`, acepta cualquier línea |
| `message_type` | string | No | `campaign` \| `chatbot` \| `sequence`. Default: `campaign` |

---

## Nodos n8n

| # | Nombre | Tipo | Descripción |
|---|--------|------|-------------|
| 1 | Webhook | `webhook` | Recibe POST con `region` y `message_type` |
| 2 | Set Defaults | `set` | Normaliza inputs: region=null si ausente, type='campaign' si ausente |
| 3 | Postgres – Get Available Line | `postgres` | Llama a `get_available_line(region, type)` — devuelve la mejor línea disponible |
| 4 | IF – Line Found | `if` | Verifica que el resultado no esté vacío |
| 5 | Postgres – Increment Counters | `postgres` | Llama a `increment_line_counters(line_id)` — incrementa msgs_sent_hour/day |
| 6 | Respond – Line Data | `respondToWebhook` | Retorna datos de la línea seleccionada (200) |
| 7 | Respond – No Line | `respondToWebhook` | Retorna error 503 si no hay líneas disponibles |
| 8 | Postgres – Reset Counters | `postgres` | Llama `reset_line_counters_if_due()` antes de buscar (limpia contadores vencidos) |

---

## Flujo paso a paso

```
[1. Webhook POST /webhook/line-selector]
        │
        ▼
[2. Set Defaults]
   region = body.region ?? null
   message_type = body.message_type ?? 'campaign'
        │
        ▼
[8. Postgres: reset_line_counters_if_due()]
   -- Limpia contadores de horas/días vencidos antes de evaluar disponibilidad
        │
        ▼
[3. Postgres: SELECT * FROM get_available_line($region, $type)]
   -- Retorna la línea con menor carga, conectada y con rate disponible
        │
        ├── resultado vacío ──────────────────────────────────────►[7. Respond 503]
        │                                                             { error: "NO_LINE_AVAILABLE" }
        │
        └── tiene línea ──►
                    │
                    ▼
        [5. Postgres: increment_line_counters(line_id)]
                    │
                    ▼
        [6. Respond 200 – Line Data]
```

---

## Output exitoso (200)

```json
{
  "line_id": "uuid",
  "line_key": "line_07",
  "evolution_instance": "wa-instance-07",
  "evolution_url": "http://evolution-api:8080",
  "remaining_hour": 43,
  "remaining_day": 387,
  "selected_at": "2026-04-13T14:22:00Z"
}
```

## Output error (503)

```json
{
  "error": "NO_LINE_AVAILABLE",
  "reason": "All lines are at capacity or offline",
  "retry_after_seconds": 60
}
```

---

## Query SQL — Nodo 3

```sql
SELECT * FROM get_available_line(
  {{ $json.region }}::VARCHAR,
  {{ $json.message_type }}::VARCHAR
);
```

La función `get_available_line` (definida en `migration/001`) filtra por:
- `status = 'active'`
- `is_connected = true`
- `msgs_sent_hour < msg_per_hour`
- `msgs_sent_today < msg_per_day`
- `allowed_types @> message_type`
- `assigned_region = region` (o NULL = cualquier región)

Y ordena por `priority ASC, msgs_sent_hour ASC` (menor carga primero).

---

## Tablas DB afectadas

| Tabla | Operación |
|-------|-----------|
| `whatsapp_lines` | SELECT (vía función) + UPDATE (increment_counters) |

---

## Errores posibles

| Error | Causa | Acción |
|-------|-------|--------|
| `NO_LINE_AVAILABLE` | Todas las líneas están al límite u offline | Respond 503. WF-007 encola el mensaje en Redis |
| `DB_TIMEOUT` | Supabase no responde | Respond 503 tras 5s timeout |
| `INVALID_MESSAGE_TYPE` | `message_type` no es válido | Normaliza a `campaign` en nodo Set Defaults |

---

## Notas de implementación

- Este workflow **no tiene error handling propio** — la respuesta 503 es el manejo de error. WF-007 decide qué hacer con ella.
- El `reset_line_counters_if_due()` del nodo 8 es una optimización: evita que WF-013 tenga que ser exactamente puntual para que los contadores se liberen.
- En producción con alto volumen, complementar con Redis INCR para los contadores de rate (más rápido que Postgres UPDATE). La DB sigue siendo source of truth.
- Llamado por WF-007 en cada envío. En campañas masivas con 30 líneas activas, se ejecuta ~1.500 veces/hora.

---

## Workflows relacionados

| Workflow | Relación |
|----------|----------|
| WF-007 Send WhatsApp Message | Llama a este workflow antes de cada envío |
| WF-013 Line Health Monitor | Actualiza `is_connected` y `status` de cada línea |
| WF-016 Metrics Aggregator | Consolida `line_metrics` al cierre del día |
