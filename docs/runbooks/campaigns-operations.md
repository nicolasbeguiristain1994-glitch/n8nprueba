# Campaigns Operations Runbook

Guía accionable para operar, diagnosticar y recuperar el módulo de campañas en producción.

---

## Variables de entorno críticas

| Variable | Descripción | Impacto si falta |
|---|---|---|
| `N8N_URL` | URL base de n8n (modo single-line) | `POST /send` falla con 500. Campaña no inicia. |
| `EVOLUTION_API_KEY` | API key para Evolution (modo multi-line) | Procesador pausa la campaña con `config_missing` antes de enviar. |
| `DATABASE_URL` | Conexión a PostgreSQL | Todo el sistema falla. |

---

## Arquitectura de modos de envío

```
Campaña
├── use_multi_line = false  →  POST /api/campaigns/[id]/send
│                              └─ send-processor.ts (n8n como intermediario)
└── use_multi_line = true   →  POST /api/campaigns/[id]/dispatch
                               └─ campaign-distributor.ts (Evolution directo, por línea)
```

---

## Diagrama de estados de campaña

```
draft → running → completed
              ↓
           paused (pause_reason indica por qué)
              ↓
           running (reanudación manual)
              ↓
         cancelled (terminal)
```

---

## pause_reason: significado y acción

| Valor | Qué pasó | Qué hacer |
|---|---|---|
| `manual` | Operador presionó "Pausar" | Reanudar cuando sea conveniente. |
| `no_eligible_lines` | No hay líneas activas, conectadas y con cuota disponible | Reconectar líneas, esperar reset de contadores (hourly/daily), luego reanudar. |
| `all_lines_outside_schedule` | Hay líneas con cuota pero todas fuera de su ventana de personalidad | Esperar a que entren en horario, luego reanudar. Las líneas se activan solas en su ventana. |
| `systemic_error` | Errores de DB o red sostenidos — el procesador detectó N ciclos con 100% de rechazos | Revisar logs con `level:critical` o `alert:true`. Diagnosticar DB/red. Reanudar solo si el problema está resuelto. |
| `config_missing` | Falta `EVOLUTION_API_KEY` | Configurar la variable de entorno y hacer redeploy. Reanudar campaña. |
| `frequency_exhausted` | Todos los contactos bloqueados por motor de frecuencia | Los contactos se liberan en su próxima ventana (24h, 7d). No hay acción necesaria — considerar crear una nueva campaña en el futuro. |
| `unknown` o `null` | Pausa no clasificada (estado legacy o inesperado) | Verificar logs del momento de la pausa. Reanudar si no hay indicios de error. |

---

## Cómo diagnosticar una campaña pausada

### 1. Verificar el pause_reason

```sql
SELECT id, name, status, pause_reason, processor_locked_at, updated_at
FROM campaigns
WHERE status = 'paused'
ORDER BY updated_at DESC;
```

### 2. Ver logs estructurados del procesador

Filtrar por campaña y eventos críticos:

```
# Datadog / Loki
level:critical AND campaignId:<uuid>
# OR
alert:true AND campaignId:<uuid>

# CloudWatch Logs Insights
filter alert = true | filter campaignId = "<uuid>"
```

Eventos clave a buscar:
- `campaign.paused` — con el campo `pause_reason` indica por qué paró
- `processor.crashed` — el procesador tiró una excepción no capturada
- `config.missing` — falta EVOLUTION_API_KEY
- `cycle.all_rejected` — todos los intentos de DB fallaron en un ciclo
- `freq.engine.failopen.accumulated` — motor de frecuencia con errores repetidos

### 3. Verificar estado de líneas (multi-line)

```sql
SELECT
  id, line_key, display_name, status, is_connected, sending_enabled,
  msgs_sent_hour, msg_per_hour,
  msgs_sent_today, msg_per_day,
  last_seen_at
FROM whatsapp_lines
WHERE status = 'active'
ORDER BY priority ASC;
```

Líneas elegibles para campaña necesitan: `status='active' AND is_connected AND sending_enabled AND msgs_sent_hour < msg_per_hour AND msgs_sent_today < msg_per_day`.

---

## Cómo reanudar una campaña pausada

### Vía UI

1. Ir a Campañas → encontrar la campaña pausada
2. El banner de pausa muestra el motivo y la acción recomendada
3. Hacer clic en **Reanudar**

### Vía API

```bash
# Multi-line
POST /api/campaigns/<uuid>/dispatch

# Single-line
POST /api/campaigns/<uuid>/send
```

El endpoint es idempotente — si ya está corriendo devuelve `{ alreadyProcessing: true }`.

---

## Cómo liberar un lock stale (admin)

Si un procesador murió y dejó el lock tomado, hay dos opciones:

### Opción A: Esperar el timeout automático (30 min)

El lock expira después de 30 minutos sin heartbeat. El próximo `POST /dispatch` o `POST /send` lo toma automáticamente.

### Opción B: Force-unlock (inmediato, admin only)

Desde la UI: en campañas con estado `running` y lock > 20 min, los admins ven el botón **"Liberar lock (admin)"**.

Vía API:
```bash
POST /api/campaigns/<uuid>/force-unlock
Authorization: <admin session cookie>
```

Respuesta esperada:
```json
{ "ok": true, "message": "Lock released. Campaign set to paused — restart it manually.", "changed": true }
```

Esto:
1. Libera el lock (`processor_lock_token = NULL`, `processor_locked_at = NULL`)
2. Establece el estado en `paused`
3. Emite `lock.force_released` en logs (nivel `critical` + `alert: true`)
4. Crea entrada de auditoría

Luego simplemente reanudar la campaña normalmente.

> **Nota de seguridad**: Si el procesador original sigue vivo, fallará en su próximo heartbeat (el token ya no coincide) y se detendrá limpiamente. El force-unlock no puede causar doble envío.

---

## Qué significa `skipped`

Un destinatario con `status = 'skipped'` fue excluido por el **motor de frecuencia de contactos**:
- Límite: 1 mensaje/día, 2 mensajes/semana, cooldown de 48h entre envíos
- El contacto no recibió ningún mensaje de esta campaña
- No es un error — es una protección deliberada contra spam
- El contacto puede recibir mensajes en campañas futuras cuando su ventana se reinicie

Ver `error_detail` en `campaign_recipients` para el motivo exacto (`[freq-blocked] reason: ...`).

---

## Qué significa que el motor de frecuencia falle en silencio

Si el motor de frecuencia (ContactFrequencyEngine) lanza una excepción, el sistema usa **fail-open**: el envío continúa sin verificar límites.

Esto está documentado como política explícita: la disponibilidad de la campaña tiene prioridad sobre el control estricto de frecuencia ante fallos de infraestructura.

Cuando ocurre:
- Se emite `freq.engine.error` en logs (nivel `error`)
- Después de 10 fail-opens acumulados en la misma sesión, se emite `freq.engine.failopen.accumulated` (nivel `warn`)

Si ves muchos `freq.engine.error`, revisar:
1. Conectividad a PostgreSQL (el motor usa advisory locks transaccionales)
2. Salud de la tabla `contact_send_history` (índices, bloateo)

---

## Dónde mirar los logs

Los logs son newline-delimited JSON emitidos a stdout/stderr del proceso Next.js.

Campos clave para filtrar:
- `level`: `info` | `warn` | `error` | `critical`
- `alert`: `true` (solo en eventos `critical`)
- `event`: nombre del evento (e.g. `campaign.paused`, `processor.crashed`)
- `campaignId`: UUID de la campaña
- `mode`: `single-line` | `multi-line`

Alertas operativas mínimas recomendadas (configurar en Datadog/Loki/etc.):
```
alert:true                    → canal #ops-alerts (crítico)
event:campaign.paused AND pause_reason:systemic_error  → canal #ops-alerts
event:campaign.paused AND pause_reason:config_missing  → canal #ops-alerts (pagerduty)
event:processor.crashed                               → canal #ops-alerts
event:freq.engine.failopen.accumulated                → canal #dev-monitoring (warn)
```

---

## Checklists rápidos

### Campaña stuck en `running` sin progreso

- [ ] Ver `processor_locked_at` — ¿cuándo se tomó el lock?
- [ ] Si hace > 30 min: el lock ya debería haber expirado (timeout automático)
- [ ] Si hace < 30 min y hay lock: el procesador puede estar vivo pero lento
- [ ] Buscar en logs `heartbeat.lock.error` o `cycle.all_rejected` para esa campaña
- [ ] Si confirmado stale: usar force-unlock (admin) o esperar timeout
- [ ] Reanudar y monitorear primeros ciclos

### Campaña pausa repetidamente con `no_eligible_lines`

- [ ] Verificar líneas en UI de Líneas o con query SQL de estado
- [ ] Ver si los contadores `msgs_sent_hour`/`msgs_sent_today` están al límite
- [ ] Verificar que n8n WF-013 está corriendo y reseteando contadores
- [ ] Si n8n no corre: el reset se llama también al inicio de cada procesador multi-line

### Alta tasa de `skipped`

- [ ] Verificar los límites de frecuencia configurados en la tabla `frequency_rules`
- [ ] Revisar si la misma lista se usó en campañas recientes (cooldown 48h)
- [ ] Para re-prueba en staging: usar el botón "Resetear (pruebas)" en la UI

---

## Staging Checklist — deploy de módulo campaigns

Antes de promover a producción verificar cada ítem:

### Migraciones

- [ ] `054_campaigns_pause_reason.sql` aplicada — columna `pause_reason` existe en `campaigns`
- [ ] `055_campaigns_pause_reason_extended.sql` aplicada — CHECK constraint incluye `all_lines_outside_schedule`
- [ ] Verificar con `\d campaigns` que el constraint está activo

```sql
-- Confirmar constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'campaigns'::regclass AND conname LIKE '%pause_reason%';
```

### Variables de entorno

- [ ] `EVOLUTION_API_KEY` configurada (sin esto campaña pausa con `config_missing`)
- [ ] `N8N_URL` configurada
- [ ] `EVOLUTION_API_URL` configurada

### Smoke tests

- [ ] Crear campaña → status `draft`
- [ ] `POST /api/campaigns/{id}/dispatch` → `{ started: true }`
- [ ] Campaña pasa a `running` en UI
- [ ] Pausar manualmente → banner muestra "Pausado manualmente"
- [ ] Reanudar → vuelve a `running`
- [ ] Campaña completa → status `completed`, no aparece botón de reanudar

### Force-unlock

- [ ] Con usuario admin: bloquear lock manualmente (`UPDATE campaigns SET processor_locked_at = NOW() - interval '25 min' WHERE ...`)
- [ ] Verificar botón force-unlock aparece en UI (> 20 min)
- [ ] Click → campaña pasa a `paused`, lock=NULL
- [ ] Log contiene `{ "event": "lock.force_released", "level": "critical", "alert": true }`

### Banner de pausa

- [ ] `pause_reason = 'systemic_error'` → texto menciona "error sistémico, revisá los logs"
- [ ] `pause_reason = 'all_lines_outside_schedule'` → texto menciona "ventana de horario"
- [ ] `pause_reason = 'no_eligible_lines'` → texto menciona "sin líneas activas"
- [ ] `pause_reason = 'config_missing'` → texto menciona `EVOLUTION_API_KEY`
