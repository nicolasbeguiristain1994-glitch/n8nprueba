# Runbook: Importar Workflows en n8n

> **Fecha:** 2026-04-13
> **Tiempo estimado:** 30-45 minutos
> **Prerequisito:** n8n corriendo + Evolution API corriendo + Supabase/PostgreSQL disponible

---

## Paso 1 — Aplicar migraciones de base de datos

Ejecutar en orden (cada una es idempotente):

```bash
# Desde el directorio del proyecto
psql $DATABASE_URL < db/schema/init.sql
psql $DATABASE_URL < db/migrations/001_whatsapp_lines.sql
psql $DATABASE_URL < db/migrations/002_sequence_engine.sql
psql $DATABASE_URL < db/migrations/003_import_and_inactivity.sql
psql $DATABASE_URL < db/migrations/004_human_handoff.sql
```

Verificar que las tablas existen:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
-- Debe incluir: whatsapp_lines, line_metrics, conversation_state,
--               support_agents, import_logs, contact_tags, etc.
```

---

## Paso 2 — Configurar credenciales en n8n

Antes de importar workflows, crear estas credenciales en **Settings → Credentials**:

### 2.1 Postgres

| Campo | Valor |
|-------|-------|
| Nombre | `Postgres account` |
| Host | `db.xxxxxx.supabase.co` (o tu host) |
| Port | `5432` |
| Database | `postgres` |
| User | `postgres` |
| Password | `tu-password` |
| SSL | `enabled` |

> ⚠️ El nombre debe ser exactamente **`Postgres account`** — es el que referencian todos los workflows.

### 2.2 Header Auth (Evolution API)

| Campo | Valor |
|-------|-------|
| Nombre | `Header Auth account` |
| Header Name | `apikey` |
| Header Value | `tu-evolution-api-key` |

> ⚠️ El nombre debe ser exactamente **`Header Auth account`**.

### 2.3 Slack Bot Token (para alertas)

| Campo | Valor |
|-------|-------|
| Nombre | `Slack Bot Token` |
| Access Token | `xoxb-tu-token` |

> Si no usás Slack todavía, podés activar los workflows sin esta credencial — los nodos de Slack simplemente fallarán silenciosamente hasta configurarlos.

---

## Paso 3 — Variables de entorno en n8n

Agregar en el archivo `.env` o en la configuración de n8n:

```env
N8N_WEBHOOK_BASE_URL=http://localhost:5678
# URL base donde n8n expone sus webhooks.
# En producción: https://tu-dominio-n8n.com

OPS_REPORT_PHONE=+5491112345678
# Número al que WF-017 envía el reporte diario por WhatsApp
```

Reiniciar n8n después de agregar estas variables.

---

## Paso 4 — Importar workflows (orden obligatorio)

Los workflows se llaman entre sí, por lo que el orden de activación importa.

### 4.1 Importar todos los JSON

En n8n: **Workflows → Import from file** (o arrastrá el JSON al canvas).

Importar en este orden:

| Orden | Archivo | Notas |
|-------|---------|-------|
| 1 | `exports/WF-012-Line-Selector.json` | Base del multi-línea |
| 2 | `exports/WF-007-Send-WhatsApp-Message.json` | Llama a WF-012 |
| 3 | `exports/WF-006_Batch_Send_Dispatcher.json` | Llama a WF-007 |
| 4 | `exports/WF-008-Webhook-Inbound-WhatsApp.json` | Entrada de mensajes |
| 5 | `exports/WF-009-Intent-Router-And-AutoReply.json` | Llama a WF-010 |
| 6 | `exports/WF-010-Human-Handoff.json` | Llama a WF-007 |
| 7 | `exports/WF-011-Sequence-Engine.json` | Llama a WF-007 |
| 8 | `exports/WF-013-Line-Health-Monitor.json` | Autónomo |
| 9 | `exports/WF-014-Contact-Import.json` | Llama a WF-015 |
| 10 | `exports/WF-015-Phone-Validator.json` | Sub-workflow |
| 11 | `exports/WF-016-Metrics-Aggregator.json` | Autónomo |
| 12 | `exports/WF-017-Daily-Report.json` | Llama a WF-007 |
| 13 | `exports/WF-018-Inactivity-Trigger.json` | Llama a secuencias |
| 14 | `exports/WF-019-Retry-Failed-Messages.json` | Llama a WF-007 |

### 4.2 Asignar credenciales

Después de importar cada workflow, n8n pedirá mapear las credenciales. Seleccionar las que creaste en el Paso 2:
- Nodos `Postgres` → **Postgres account**
- Nodos `HTTP Request` a Evolution API → **Header Auth account**
- Nodos `HTTP Request` a Slack → **Slack Bot Token**

---

## Paso 5 — Inicializar las 30 líneas en Evolution API

```bash
# Revisar primero con dry-run
EVOLUTION_URL=http://localhost:8080 \
EVOLUTION_API_KEY=tu-key \
bash scripts/ops/init-lines.sh --dry-run

# Ejecutar real
EVOLUTION_URL=http://localhost:8080 \
EVOLUTION_API_KEY=tu-key \
bash scripts/ops/init-lines.sh
```

---

## Paso 6 — Activar workflows (orden)

Activar uno a uno. El switch está en la esquina superior derecha del workflow en n8n.

```
1. WF-012 Line Selector      → activar primero (es llamado por todos)
2. WF-015 Phone Validator    → activar (sub-workflow)
3. WF-007 Send WhatsApp      → activar
4. WF-008 Webhook Inbound    → activar (configura webhook en Evolution API)
5. WF-010 Human Handoff      → activar
6. WF-009 Intent Router      → activar
7. WF-013 Line Health Monitor → activar (empieza a monitorear líneas)
```

**Esperar a que WF-013 detecte líneas conectadas** antes de activar los de envío masivo:

```sql
-- Verificar en DB
SELECT line_key, is_connected, status FROM whatsapp_lines WHERE is_connected = true;
```

```
8. WF-006 Batch Dispatcher   → activar cuando haya líneas conectadas
9. WF-011 Sequence Engine    → activar
10. WF-014 Contact Import    → activar
11. WF-018 Inactivity Trigger → activar
12. WF-019 Retry Failed      → activar
13. WF-016 Metrics Aggregator → activar
14. WF-017 Daily Report      → activar último
```

---

## Paso 7 — Configurar webhook de Evolution API

Para que Evolution API notifique a n8n cuando llegan mensajes, configurar el webhook por instancia:

```bash
# Hacer para cada instancia (o usar el script de bulk)
curl -X PUT \
  "http://localhost:8080/webhook/set/wa-instance-01" \
  -H "apikey: tu-key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://tu-n8n:5678/webhook/inbound-whatsapp",
    "webhook_by_events": false,
    "webhook_base64": false,
    "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"]
  }'
```

O en bulk con el script:

```bash
# scripts/ops/set-webhooks.sh (crear si no existe)
for i in $(seq -w 1 30); do
  curl -s -X PUT \
    "$EVOLUTION_URL/webhook/set/wa-instance-${i}" \
    -H "apikey: $EVOLUTION_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$N8N_WEBHOOK_BASE_URL/webhook/inbound-whatsapp\", \"events\": [\"MESSAGES_UPSERT\", \"MESSAGES_UPDATE\", \"CONNECTION_UPDATE\"]}" \
    && echo "line_${i} OK" || echo "line_${i} FAIL"
done
```

---

## Paso 8 — Vincular las líneas (escanear QR)

Para cada instancia:

```bash
# Obtener QR de una línea
curl "http://localhost:8080/instance/connect/wa-instance-01" \
  -H "apikey: tu-key"
# Retorna base64 del QR → abrir en browser o app de QR
```

O usar la UI de Evolution API en `http://localhost:8080` → seleccionar instancia → Connect.

Verificar que WF-013 detecta la conexión:

```sql
SELECT line_key, is_connected, phone_number, last_seen_at
FROM whatsapp_lines
WHERE is_connected = true;
```

---

## Paso 9 — Smoke test

### Probar envío simple

```bash
curl -X POST http://localhost:5678/webhook/send-whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5491112345678",
    "message": "Test desde WF-007 ✅",
    "message_type": "campaign"
  }'
# Esperado: {"status": "sent", "line": "line_01", "message_id": "..."}
```

### Probar importación de contactos

```bash
# CSV mínimo en base64: phone,name\n+5491112345678,Juan Test
CSV_B64=$(echo "phone,name
+5491112345678,Juan Test" | base64)

curl -X POST http://localhost:5678/webhook/import-contacts \
  -H "Content-Type: application/json" \
  -d "{
    \"source\": \"csv\",
    \"data\": \"$CSV_B64\",
    \"mapping\": {\"phone\": \"phone\", \"first_name\": \"name\"}
  }"
# Esperado: {"status": "completed", "imported": 1, "updated": 0, ...}
```

### Probar Line Selector

```bash
curl -X POST http://localhost:5678/webhook/line-selector \
  -H "Content-Type: application/json" \
  -d '{"region": "AR", "message_type": "campaign"}'
# Esperado: {"line_id": "...", "line_key": "line_01", ...}
```

---

## Troubleshooting frecuente

| Síntoma | Causa probable | Solución |
|---------|---------------|---------|
| WF-007 devuelve `503 NO_LINE_AVAILABLE` | Ninguna línea activa/conectada | Conectar QR, esperar WF-013 |
| WF-012 da error de credencial Postgres | Nombre de credencial distinto | Renombrar a `Postgres account` exactamente |
| WF-008 no recibe mensajes | Webhook de Evolution no configurado | Ejecutar Paso 7 |
| WF-011 no ejecuta pasos | Sin executions en `sequence_executions` | Correr WF-018 o insertar manualmente |
| `DUPLICATE_MESSAGE` en WF-007 | dedup_key ya existe en DB | Normal — el sistema funciona. Si es falso positivo, limpiar `deduplication_cache` |

---

## Variables de entorno completas (.env)

```env
# n8n
N8N_WEBHOOK_BASE_URL=http://localhost:5678
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=tu-password

# Base de datos
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres

# Evolution API
EVOLUTION_URL=http://evolution-api:8080
EVOLUTION_API_KEY=tu-api-key

# Operaciones
OPS_REPORT_PHONE=+5491112345678
SLACK_BOT_TOKEN=xoxb-tu-token
```
