# System Design — WhatsApp Automation Platform

**Versión:** 1.0  
**Última actualización:** 2026-04  
**Estado:** Living Document (en evolución con el roadmap)

---

## Tabla de contenidos

1. [Visión General](#visión-general)
2. [Arquitectura de Alto Nivel](#arquitectura-de-alto-nivel)
3. [Módulos del Sistema](#módulos-del-sistema)
4. [Modelo de Datos](#modelo-de-datos)
5. [Flujos de Negocio](#flujos-de-negocio)
6. [Decisiones Técnicas](#decisiones-técnicas)
7. [Integraciones](#integraciones)
8. [Consideraciones de Escalabilidad](#consideraciones-de-escalabilidad)
9. [Seguridad y Compliance](#seguridad-y-compliance)
10. [Plan de Deployment](#plan-de-deployment)

---

## Visión General

### Propósito
Plataforma de orquestación de comunicaciones vía WhatsApp para operaciones de iGaming en LATAM, automatizando el ciclo completo del jugador: onboarding, retención, pagos, soporte y controles de riesgo.

### Objetivos principais

| Objetivo | Métrica | Fase |
|----------|---------|------|
| Comunicar el 100% de eventos clave sin latencia manual | SLA < 2 min | MVP (Fase 1) |
| Reducir fricción en onboarding | Tasa de completitud > 85% | Fase 1-2 |
| Identificar riesgo antes de que afecte ingresos | Detección < 24h | Fase 3 |
| Automatizar 80% de interacciones de soporte | % mensajes sin escalado | Fase 2 |
| Visibilidad operativa en tiempo real | Dashboard actualizado c/5min | Fase 4 |

### Usuarios y Casos de Uso

```
┌─────────────────────────────────────────┐
│ Jugadores (end-users)                   │
│ • Reciben mensajes de bienvenida        │
│ • Notificaciones de transacciones       │
│ • Ofertas personalizadas                │
└─────────────────────────────────────────┘
                    ↑
        (WhatsApp Business API)
                    ↓
┌─────────────────────────────────────────┐
│ Plataforma de Automatización             │
│ (n8n + PostgreSQL + Redis)              │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│ Operaciones & Compliance                │
│ • Dashboards de métricas                │
│ • Alertas de riesgo                     │
│ • Reports para reguladores              │
└─────────────────────────────────────────┘
```

---

## Arquitectura de Alto Nivel

### Componentes Principales

```
┌────────────────────────────────────────────────────────────────┐
│                     Capa de Presentación                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │ n8n UI       │    │ Dashboards   │    │ APIs Backend │     │
│  │ (workflows)  │    │ Operativos   │    │ (webhooks)   │     │
│  └──────────────┘    └──────────────┘    └──────────────┘     │
└────────────────────────────────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│                  Capa de Orquestación (n8n)                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │
│  │  Workflows  │ │ Triggers    │ │  LLM/Logic  │              │
│  │  (60+ flujos)│ │ (webhooks,  │ │  (templating)│             │
│  └─────────────┘ │  timer-based)│ └─────────────┘             │
│                  └─────────────┘                               │
└────────────────────────────────────────────────────────────────┘
         ↓              ↓              ↓              ↓
    ┌─────────┐   ┌─────────┐   ┌──────────┐   ┌─────────┐
    │PostgreSQL│   │  Redis  │   │ WhatsApp │   │ External│
    │(source   │   │  Cache  │   │  Business│   │APIs     │
    │of truth) │   │ & Queue │   │  API     │   │(webhooks)
    └─────────┘   └─────────┘   └──────────┘   └─────────┘
```

### Stack Tecnológico

| Componente | Herramienta | Razón |
|-----------|-------------|-------|
| **Orquestación** | n8n (self-hosted) | Workflows visuales, sin vendor lock-in, comunidad activa |
| **DB Principal** | PostgreSQL (Supabase) | Transacciones ACID, JSONB para templates, escalabilidad conocida |
| **Cache/Queue** | Redis | Deduplicación en tiempo real, rate-limiting, caché de templates |
| **Mensajería** | WhatsApp Business API / Evolution API | Oficial, compliance, SLA de entrega |
| **Backend auxiliar** | Node.js / Python (scripts) | Transformación de datos, imports masivos |
| **IaC** | Docker + GitHub Actions | Reproducibilidad, CI/CD |

---

## Módulos del Sistema

### 1️⃣ Módulo de Comunicaciones (COMMS)

**Responsabilidad:** Envío de mensajes, templating y tracking de entrega

#### Subcomponentes

- **Motor de Plantillas**
  - Ubicación: `/src/templating/`
  - Responsable de: Renderizar variables en plantillas
  - Entrada: Template name + contexto del jugador
  - Salida: Mensaje renderizado y validado

- **Queue de Mensajes** (Redis)
  - Estructura: `whatsapp:outbound:{priority}:{uuid}`
  - Deduplicación: Hash de `(phone, message_type, workflow_id, timestamp)`
  - TTL: 24h para mensajes pendientes
  - Circuit breaker: Si Evolution API retorna 429, backoff exponencial

- **Evolution API Adapter**
  - Normalización de respuestas (mensaje_id, timestamp, status)
  - Reintentos automáticos (exponential backoff: 1s, 2s, 4s, 8s)
  - Logging de cada solicitud en `whatsapp_messages`

#### Workflows Principales (Fase 1)
- `ONBOARDING_bienvenida_nuevo_jugador`
- `PAGOS_deposito_confirmado`
- `PAGOS_retiro_procesado`
- `SOPORTE_faq_bot` (bot de preguntas frecuentes)

---

### 2️⃣ Módulo de CRM & Retención (CRM)

**Responsabilidad:** Segmentación, perfiles de jugadores, automatización de retención

#### Subcomponentes

- **Data Lake de Jugadores**
  - Tabla: `players` (sincronizado diariamente desde API de casino)
  - Enriquecimiento: comportamiento de envíos, conversiones, segmentación
  - TTL de caché en Redis: 24h

- **Segmentación en tiempo real**
  - Casual: < 3 depósitos o inactivo > 7 días
  - Regular: 3-10 depósitos en últimas 30 días
  - VIP: > 10 depósitos o lifetime value > USD 5,000
  - Regla: Calculada al enviar cada mensaje (table `players.segment`)

- **Eventos de Retención**
  - Trigger: Inactividad por D+3, D+7, D+14
  - Lógica: Query a PostgreSQL de  últimas transacciones, si no hay → enviar incentivo
  - Deduplicación: No enviar si ya se envió incentivo hace < 3 días

#### Workflows Principales (Fase 2)
- `RETENCION_inactivo_d3`
- `RETENCION_inactivo_d7`
- `RETENCION_inactivo_d14`
- `RETENCION_bono_cumpleaños`
- `RETENCION_oferta_personalizada`

---

### 3️⃣ Módulo de Risk & Compliance (RISK)

**Responsabilidad:** Detección de anomalías, alertas operativas, auditoría

#### Subcomponentes

- **Rule Engine (reglas de riesgo)**
  - Bonus abuse: retiros > USD 10k dentro de 24h del primer depósito
  - Multi-account: 2+ cuentas con mismo phone numbers
  - High withdrawal: retiros progresivos > USD 50k
  - Reglas guardadas en PostgreSQL (`risk_flags` table)
  - Verificación: Por cada transacción en webhook

- **Alertas en tiempo real**
  - Disparador: Webhook del casino (transacciones)
  - Procesamiento: n8n evalúa reglas en < 100ms
  - Acción: Escribir fila en `risk_flags`, enviar notificación a Slack/email

- **Auditaría de Workflows**
  - Tabla: `workflow_executions`
  - Registra: input, output, errores, duración
  - Retention: 90 días (después, archivo a S3)

#### Workflows Principales (Fase 3)
- `RISK_retiro_alto_umbral`
- `RISK_bonus_abuse_detection`
- `RISK_multi_account_flag`
- `OPS_reporte_compliance_diario`

---

### 4️⃣ Módulo de Reportería (REPORTING)

**Responsabilidad:** Dashboards, exports, KPIs

#### Subcomponentes

- **Agregación de datos**
  - Jobs programados: Cada 6h se agregan stats de últimas 24h
  - Tablas: `aggregated_metrics` (denormalizada para rápido acceso)
  - Métricas: Mensajes enviados/entregados/fallidos, tasa de conversión

- **Exports programados**
  - CSV diarios: Transacciones, eventos de riesgo
  - Envío: Email a operaciones, Slack a compliance
  - Generated por: Workflow `OPS_export_transacciones_diarias`

- **Dashboards en tiempo real**
  - Herramienta: Metabase (conectado a PostgreSQL)
  - Actualizacion: Cada 5 minutos vía scheduled queries
  - Métricas: Flujo diario de mensajes, tasas de entrega, errores

---

### 5️⃣ Módulo de Orquestación (ORCHESTRATION)

**Responsabilidad:** Coordinación de workflows, scheduling, manejo de errores

#### Subcomponentes

- **Scheduler Central**
  - Triggers soportados: Webhooks, timers (cron), eventos en DB
  - Almacenamiento: Base de datos n8n (SQLite o PostgreSQL)
  - Deduplicación: Hash de (workflow_id, player_id, event_time) con TTL 5 min

- **Error Handling & Observability**
  - Reintentos automáticos: 3 intentos con exponential backoff
  - Dead letter queue: Mensajes fallidos después de 3 reintentos → tabla `failed_workflows`
  - Logs: Stdout + PostgreSQL table `workflow_executions`
  - Alertas: Slack si tasa de error > 5% en 5 min

- **Rate Limiting**
  - Por jugador: Max 3 mensajes/hora (configurable por tipo)
  - Global: Max 1000 mensajes/min (basado en capacidad de Evolution API)
  - Implementación: Redis `ratelimit:player:{id}:count`

---

## Modelo de Datos

### Diagrama ER (Entidad-Relación)

```
┌──────────────────────────────────┐
│         players                  │
├──────────────────────────────────┤
│ id (UUID, PK)                    │
│ external_id (VARCHAR, UNIQUE)    │
│ phone (VARCHAR, E.164)           │
│ first_name (VARCHAR)             │
│ email (VARCHAR)                  │
│ country_code (CHAR(2))           │
│ segment (VARCHAR)                │ → casual|regular|vip
│ status (VARCHAR)                 │ → active|suspended|closed
│ created_at (TIMESTAMPTZ)         │
│ updated_at (TIMESTAMPTZ)         │
│ [metadata] (JSONB)               │
└──────────────────────────────────┘
              ↓ 1:N
┌──────────────────────────────────────────────┐
│       whatsapp_messages                      │
├──────────────────────────────────────────────┤
│ id (UUID, PK)                                │
│ player_id (UUID, FK)                         │
│ phone (VARCHAR, E.164)                       │
│ message_type (VARCHAR)                       │ → onboarding|retention|payment|support|risk
│ template_name (VARCHAR)                      │
│ message_body (TEXT)                          │
│ status (VARCHAR)                             │ → sent|delivered|read|failed
│ evolution_message_id (VARCHAR)               │
│ workflow_name (VARCHAR)                      │
│ sent_at (TIMESTAMPTZ)                        │
│ delivered_at (TIMESTAMPTZ, NULLABLE)         │
│ read_at (TIMESTAMPTZ, NULLABLE)              │
│ error_detail (TEXT, NULLABLE)                │
│ [metadata] (JSONB)                           │
└──────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│   whatsapp_templates                        │
├─────────────────────────────────────────────┤
│ id (UUID, PK)                               │
│ name (VARCHAR, UNIQUE)                      │ → domain-event-variant (ej: onboarding-bienvenida-default)
│ domain (VARCHAR)                            │
│ language (VARCHAR)                          │
│ body (TEXT)                                 │
│ variables (JSONB)                           │ → ["nombre", "monto", "fecha"]
│ placeholders_regex (VARCHAR)                │ → regex para detectar {{var}}
│ active (BOOLEAN)                            │
│ owner_email (VARCHAR)                       │ → responsable de la template
│ created_at (TIMESTAMPTZ)                    │
│ updated_at (TIMESTAMPTZ)                    │
│ [version] (INT)                             │ → para rollback
└─────────────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│    workflow_executions                         │
├────────────────────────────────────────────────┤
│ id (UUID, PK)                                  │
│ workflow_name (VARCHAR)                        │
│ workflow_id (VARCHAR)                          │ → ID de n8n
│ trigger_event (VARCHAR)                        │
│ player_id (UUID, FK, NULLABLE)                 │
│ status (VARCHAR)                               │ → success|error|skipped
│ input_data (JSONB)                             │
│ output_data (JSONB)                            │
│ error_message (TEXT, NULLABLE)                 │
│ error_stack (TEXT, NULLABLE)                   │
│ executed_at (TIMESTAMPTZ)                      │
│ completed_at (TIMESTAMPTZ, NULLABLE)           │
│ duration_ms (INTEGER)                          │
│ retry_count (INT DEFAULT 0)                    │
└────────────────────────────────────────────────┘

┌───────────────────────────────────────┐
│        risk_flags                     │
├───────────────────────────────────────┤
│ id (UUID, PK)                         │
│ player_id (UUID, FK)                  │
│ flag_type (VARCHAR)                   │ → bonus_abuse|multi_account|high_withdrawal|etc
│ severity (VARCHAR)                    │ → low|medium|high|critical
│ detail (TEXT)                         │
│ source_workflow (VARCHAR)              │
│ resolved (BOOLEAN DEFAULT false)      │
│ created_at (TIMESTAMPTZ)              │
│ resolved_at (TIMESTAMPTZ, NULLABLE)   │
│ resolution_note (TEXT, NULLABLE)      │
└───────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│       aggregated_metrics (denormalizado)        │
├─────────────────────────────────────────────────┤
│ id (UUID, PK)                                   │
│ metric_date (DATE)                              │
│ total_messages_sent (INT)                       │
│ total_messages_delivered (INT)                  │
│ total_messages_failed (INT)                     │
│ by_domain (JSONB)                               │ → {onboarding: 150, retention: 200, ...}
│ unique_players (INT)                            │
│ avg_send_latency_ms (INT)                       │
│ error_rate (DECIMAL)                            │
│ created_at (TIMESTAMPTZ)                        │
└─────────────────────────────────────────────────┘
```

### Tablas Futuras (Fases 2-4)

```sql
-- Transacciones (sincronizado del casino)
CREATE TABLE transactions (
    id UUID PRIMARY KEY,
    player_id UUID REFERENCES players(id),
    type VARCHAR(20),  -- deposit | withdrawal | bonus | refund
    amount DECIMAL(10, 2),
    currency VARCHAR(3),
    status VARCHAR(20),
    created_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Ofertas (para A/B testing)
CREATE TABLE offers (
    id UUID PRIMARY KEY,
    player_id UUID REFERENCES players(id),
    offer_name VARCHAR(100),
    bonus_amount DECIMAL(10, 2),
    conditions TEXT,
    sent_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

-- Eventos de engagement
CREATE TABLE engagement_events (
    id UUID PRIMARY KEY,
    player_id UUID REFERENCES players(id),
    event_type VARCHAR(50),  -- message_opened | offer_clicked | deposit_made
    metadata JSONB,
    created_at TIMESTAMPTZ
);
```

### Índices Críticos

```sql
-- Búsquedas por jugador
CREATE INDEX idx_players_phone ON players(phone);
CREATE INDEX idx_players_segment ON players(segment) WHERE status = 'active';
CREATE INDEX idx_players_external_id ON players(external_id);

-- Búsquedas de mensajes
CREATE INDEX idx_wa_messages_player_sent ON whatsapp_messages(player_id, sent_at DESC);
CREATE INDEX idx_wa_messages_status ON whatsapp_messages(status, sent_at DESC);
CREATE INDEX idx_wa_messages_workflow ON whatsapp_messages(workflow_name, sent_at DESC);

-- Búsquedas de riesgo
CREATE INDEX idx_risk_flags_player_unresolved ON risk_flags(player_id) 
    WHERE resolved = false;
CREATE INDEX idx_risk_flags_severity ON risk_flags(severity, created_at DESC);

-- Auditoría
CREATE INDEX idx_workflow_executions_status_date ON workflow_executions(status, executed_at DESC);
```

---

## Flujos de Negocio

### 🎯 Flujo 1: Onboarding (Nuevo Jugador)

```
Evento: Nuevo jugador se registra en casino
   ↓ (webhook)
n8n: ONBOARDING_bienvenida_nuevo_jugador
   ├─ Validar: existe jugador en players table
   ├─ Consultar: última actividad del jugador
   ├─ Deduplicar: ¿Ya se envió bienvenida hace < 1h?
   ├─ Renderizar: template "onboarding-bienvenida-default"
   ├─ Validar teléfono: E.164, no es bot, no está en blocklist
   ├─ Encolar: Redis queue
   ├─ Enviar: Evolution API (GET /messages/send)
   ├─ Registrar: whatsapp_messages (status: sent)
   └─ Output: Éxito o fallo con retry automático (3x)
```

**Tiempos:**
- Latencia de extremo a extremo: < 30 segundos
- Entrega a jugador: < 5 minutos (SLA)

**Manejo de errores:**
- Teléfono inválido → log + skip (no reintentar)
- API timeout → retry após 10s (máx 3x)
- Rate limit (429) → exponential backoff (1s → 2s → 4s)

---

### 🎯 Flujo 2: Notificación de Transacción

```
Evento: Casino webhook → /api/n8n/transaction
   ↓
n8n: PAGOS_deposito_confirmado (o retiro)
   ├─ Validar: estructura de webhook (firma HMAC)
   ├─ Consultar: player data en PostgreSQL
   ├─ Determinar: tipo de plantilla (deposito vs retiro)
   ├─ Renderizar: template con monto, fecha, cuenta
   ├─ Aplicar lógica: ¿mostrar resumen de cuenta? ¿sugerir bono?
   ├─ Rate check: ¿jugador ya recibió msg en última 1h?
   ├─ Enviar: WhatsApp
   ├─ Registrar: whatsapp_messages + transaction (en tabla `transactions`)
   └─ Retornar: 200 OK a casino (idempotente por UUID)
```

**Alto valor:**
- Confirmación inmediata de transacción → retención
- Impacto en conversión directa

---

### 🎯 Flujo 3: Detección de Riesgo (Fraud Detection)

```
Evento: Transacción procesada (webhook casino)
   ↓
n8n: Evaluador de reglas de riesgo
   ├─ Cargar reglas desde DB (tabla: risk_rules)
   ├─ Evaluar: Bonus abuse
   │  └─ IF (retiro > USD 10k AND días desde primer depósito < 1)
   │     THEN flag_type = "bonus_abuse", severity = "high"
   ├─ Evaluar: Multi-account
   │  └─ SELECT COUNT(players) WHERE phone = X AND status != 'closed'
   │     IF count > 1 THEN flag_type = "multi_account"
   ├─ Evaluar: High withdrawal
   │  └─ IF (retiro_sum en últimas 24h > USD 50k) THEN flag
   ├─ Crear flag: INSERT risk_flags (si no existe similar reciente)
   ├─ Notificar: Slack a #compliance (con detalles)
   ├─ Enviar alerta: Email a operaciones
   └─ Registrar: workflow_executions (auditaría)
```

**Objetivo:**
- Detectar riesgo en < 100ms
- Alertar humanos para revisión

---

### 🎯 Flujo 4: Reporte Diario (OPS)

```
Trigger: Timer cada día a las 06:00 UTC-3
   ↓
n8n: OPS_reporte_diario
   ├─ Consultar: Agregados del día anterior (tabla aggregated_metrics)
   ├─ Calcular: KPIs
   │  ├─ Mensajes enviados / entregados / fallidos
   │  ├─ Tasa de error
   │  ├─ Flags de riesgo generados
   │  └─ Jugadores nuevos
   ├─ Generar: CSV con detalles
   ├─ Enviar: Email a operaciones + Slack a #daily-report
   ├─ Almacenar: Reporte en S3/Supabase Storage
   └─ Registrar: workflow_executions (auditaría)
```

---

## Decisiones Técnicas

### 1. Por qué **n8n** para orquestación

| Criterio | Opción | Razón de rechazo |
|----------|--------|------------------|
| **Sin código visual** | Zapier/Make | Precio prohibitivo para volumen (1000+ msgs/día), vendor lock-in |
| **Open-source self-hosted** | n8n | ✅ ELEGIDO: Sin costo de suscripción, control total, comunidad activa |
| **Serverless/FaaS** | AWS Lambda | Overhead de dev, frío-caliente, menos visual |
| **Herramienta interna** | BUILD | Tiempo de dev demasiado alto para MVP |

**Trade-offs:**
- ✅ Workflows visuales, fácil para no-devs
- ✅ Community plugins para WhatsApp, PostgreSQL, Redis
- ⚠️ Requiere mantener servidor (pero IT ya tiene)
- ⚠️ Menos flexible que código custom (pero faster TTM)

---

### 2. Por qué **PostgreSQL** (Supabase)

| Criterio | Opción | Razón de rechazo |
|----------|--------|------------------|
| **SQL robusto** | PostgreSQL | ✅ ELEGIDO: Transacciones ACID, JSONB, escalable, costos predecibles |
| **NoSQL** | MongoDB | JSON flexible BUT sin ACID, joins complejos, overkill |
| **In-memory** | Redis only | NO: Pérdida de datos, no es source-of-truth |
| **Graph** | Neo4j | Overkill, no necesitamos relaciones complejas ahora |

**Razones técnicas:**
- JSONB para templates y metadata: flexible + queryable
- Foreign keys: garantizar integridad referencial
- Transacciones: garantizar consistencia en duplicates
- Índices: rápido acceso a players por teléfono/segment
- Full-text search: futuro para búsqueda de mensajes

---

### 3. Por qué **Redis** para caché y queue

| Criterio | Opción | Razón de rechazo |
|----------|--------|------------------|
| **Cache en-memory + queue** | Redis | ✅ ELEGIDO: < 1ms de latencia, deduplicacion, rate-limiting |
| **RabbitMQ/KAFKA** | Message broker | Overkill para volumen actual, setup + maintenance complejo |
| **PostgreSQL queue** | pgqueue | Más lento (> 50ms), no es ideal para alta frecuencia |
| **n8n built-in queue** | n8n Q | Insuficiente para rate-limiting global + deduplicación |

**Casos de uso en Redis:**
```
whatsapp:outbound:{priority}:{uuid}      → Cola de mensajes por enviar
ratelimit:player:{player_id}:count       → Contador rate-limit por jugador
template:{templatename}:v{version}       → Caché de templates (TTL 24h)
dedup:workflow:{id}:player:{pid}:ts      → Ever-seen (TTL 5min)
risk:flag:pending                        → Flags recientes para dashboards
```

---

### 4. Por qué **Evolution API** vs WhatsApp Business API

| Aspecto | Evolution | WSP Official | Razón |
|--------|-----------|------------|-------|
| **SLA de entrega** | 99% | 99.5% | Levemente mejor official |
| **Costo** | Más barato | Standard | ✅ Considerando volumen |
| **Integración** | > simple | Oficial | Similar |
| **Compliance** | Supported | Garantizado | Ambos OK |
| **Multi-device** | ✅ Sí | No | Útil si falla servidor |

**Decisión:** Empezar con Evolution API (cheaper), migrar a Official en Fase 3 si volumen lo justifica.

---

### 5. Deduplicación Strategy

**Implementación de multi-layer:**

```python
# Layer 1: Redis (TTL 5min)
KEY = f"dedup:workflow:{workflow_id}:player:{player_id}:msg_type:{type}"
IF EXISTS redis.get(KEY):
    RETURN "SKIP" (mensaje idéntico reciente)
ELSE:
    redis.set(KEY, workflow_id, EX=300)  # 5 min TTL

# Layer 2: PostgreSQL (historical)
# Antes de enviar, check:
SELECT sent_at FROM whatsapp_messages 
WHERE player_id = X 
  AND message_type = Y 
  AND workflow_name = Z
  AND sent_at > NOW() - INTERVAL '1 hour'
IF found:
    RETURN "SKIP"

# Layer 3: Idempotenencia de Evolution API
# Enviar: evolution_message_id = "{workflow}:{player}:{ts}"
# Evolution ignora si mismo ID viene 2x en 10 segundos
```

---

### 6. Rate Limiting Strategy

```yaml
Límites por tipo:
  - Jugador: máx 3 mensajes/hora
    Razón: No spam, compliance, buena UX
  
  - Global: máx 1000 msgs/min
    Razón: Capacidad de Evolution API
  
  - Por dominio:
    - Onboarding: Urgente (skip limit)
    - Risk: Alta prioridad
    - Retention: Baja prioridad
    
Implementación:
  Tier 1 (Redis): INCR ratelimit:player:{id}:count EXPIRE 3600
  Tier 2 (Redis): INCR ratelimit:global:count EXPIRE 60
  Si alguno se excede → mover a retry queue con backoff
```

---

### 7. Error Handling & Retry Policy

```yaml
Error types y política:

Transient (RETRY):
  - Timeout (Evolution no responde en 10s)
    Retry: 3x con backoff exponencial (1s, 2s, 4s)
  
  - Rate limit 429
    Retry: 3x con backoff (10s, 20s, 40s)
  
  - Temporary API error 5xx
    Retry: 3x con backoff (5s, 10s, 20s)

Permanent (SKIP):
  - Invalid phone (E.164 parse error)
    Action: Log error, flag jugador, alert
  
  - Player not found
    Action: Skip, log, investigate
  
  - Template not found
    Action: Incident alert, check deployment

Dead Letter:
  - Después de 3 reintentos fallidos
  - INSERT failed_workflows table
  - Slack alert a #incidents
  - Manual review por operaciones
```

---

### 8. Logging & Observability

```
Niveles:
  DEBUG    → Entrada/salida de funciones (Redis, DB queries)
  INFO     → Hitos del workflow (mensaje enviado, flag creado)
  WARNING  → Comportamiento inesperado (jugador en blocklist, rate-limit)
  ERROR    → Fallos (timeout, exception, retiro fallido)
  CRITICAL → Sistema down (DB connection lost, API no responde)

Sink:
  Stdout          → Logs en tiempo real (docker logs)
  PostgreSQL      → workflow_executions (auditaría)
  DataDog/NewRelic → Traces distribuidos, APM (futuro)
  
Retention:
  PostgreSQL: 90 días
  S3 Archivos: 1 año (compliance)
```

---

## Integraciones

### Integraciones Externas

```
┌────────────────────────────────────────────────────┐
│               Plataforma n8n                        │
└────────────────────────────────────────────────────┘
         ↓              ↓              ↓
    ┌─────────┐  ┌──────────────┐  ┌──────────┐
    │ Casino  │  │ Evolution    │  │PostgreSQL│
    │ Webhooks│  │ API          │  │(Supabase)│
    │(POST)   │  │(REST)        │  │          │
    └─────────┘  └──────────────┘  └──────────┘
```

#### 1. Casino (Source of Truth)

```yaml
Ingreso:
  - Webhook POST /api/n8n/transaction
  - Headers: X-Webhook-Signature (HMAC-SHA256)
  - Payload:
      event_type: "transaction"
      player_id: "ext_123"
      amount: 100.00
      type: "deposit"
      
Salida:
  - No hay (n8n es consumidor)

Manejo de errores:
  - 400: payload inválido → log + HTTP 400
  - 409: recurso duplicado (ya procesado) → HTTP 200 (idempotente)
  - 5xx: error interno → HTTP 500 (casino reintentará)
```

#### 2. Evolution API (WhatsApp)

```yaml
Envío:
  POST /api/sendMessage
  {
    "phone": "+5491112345678",
    "message": "Hola {{nombre}}, bienvenido",
    "idempotency_key": "workflow:player:ts"
  }
  
Respuesta:
  {
    "success": true,
    "messageId": "wamid_xyz",
    "timestamp": "2026-04-06T12:00:00Z"
  }

Webhook de status:
  POST /api/n8n/whatsapp-status
  {
    "messageId": "wamid_xyz",
    "status": "delivered" | "read" | "failed",
    "timestamp": "..."
  }
  
Rate Limit:
  - 1000 msgs/min global
  - 100 msgs/min por account
  - Si 429 → backoff exponencial
```

#### 3. PostgreSQL (Data Persistence)

```sql
-- Operaciones principales
SELECT * FROM players WHERE external_id = ?
INSERT INTO whatsapp_messages (...)
UPDATE players SET segment = ? WHERE id = ?
INSERT INTO workflow_executions (...)
SELECT * FROM risk_flags WHERE player_id = ? AND resolved = false
```

---

## Consideraciones de Escalabilidad

### Escenario 1: MVP (Fase 1)
- **Volumen:** 100-500 mensajes/día
- **Jugadores:** 1,000-5,000 activos
- **Infrastructure:** Single n8n instance + PostgreSQL standard
- **Redis:** Optional (caché solo)

### Escenario 2: Growth (Fase 2)
- **Volumen:** 5,000-50,000 mensajes/día
- **Jugadores:** 50,000+ activos
- **Cambios:**
  - n8n: Considerar múltiples workers (horizontal scaling)
  - PostgreSQL: Read replicas para dashboards
  - Redis: Cluster para deduplicación distribuida
  - Caché: Implementar CDN para templates

### Escenario 3: Scale (Fase 3+)
- **Volumen:** 100,000+ mensajes/día
- **Jugadores:** 500,000+
- **Cambios:**
  - n8n: Kubernetes cluster (auto-scaling)
  - PostgreSQL: Sharding por región geográfica
  - Redis: Managed service (AWS ElastiCache)
  - Message broker: Considerar Apache Kafka
  - Event sourcing: Arcar eventos en time-series DB (InfluxDB)

### Query Optimization

```sql
-- ❌ EVITAR: Full table scan
SELECT * FROM whatsapp_messages 
WHERE phone = '+5491112345678'

-- ✅ USAR: Indexed
SELECT * FROM whatsapp_messages 
WHERE player_id = (SELECT id FROM players WHERE phone = '+5491112345678')
AND sent_at > NOW() - INTERVAL '7 days'

-- ✅ USAR: Aggregate query
SELECT date(sent_at) as date, COUNT(*) as count, Status
FROM whatsapp_messages
WHERE sent_at > NOW() - INTERVAL '30 days'
GROUP BY date, status
```

---

## Seguridad y Compliance

### 1. Autenticación & Autorización

```yaml
Casino Webhooks:
  - Validar firma: HMAC-SHA256(body, secret_key)
  - Rechazar si firma inválida → HTTP 401
  - Log de intentos fallidos

n8n Admin:
  - OAuth2 con SSO de IT (OKTA/Entra)
  - Roles: Admin | Editor | Viewer
  - 2FA obligatorio

API Keys:
  - Rotate cada 90 días
  - Almacenar hashed en Supabase
  - Audit log de uso
```

### 2. Data Privacy

```yaml
Phones:
  - Almacenar E.164 normalizados
  - Encryption at rest (PostgreSQL native encryption)
  - Mascareo en logs: +549111XXXX

Mensajes:
  - NO almacenar contenido sensible (passwords, OTP)
  - Encriptar templates con variables de usuario

Retention:
  - Players: indefinido
  - Mensajes: 2 años (compliance)
  - Logs: 90 días → archivos en S3 (encrypted)
  - Riesgo: 1 año (auditaría)
```

### 3. Compliance (iGaming LATAM)

```yaml
Regulatorio:
  - GDPR: Si jugadores de EU → derecho a olvido
  - Regulaciones LATAM: Guardar logs de comunicaciones
  - No enviar spam (máx 3 msgs/día/jugador)

Auditoría:
  - Tabla workflow_executions: IMMUTABLE
  - Hash de cambios en risk_flags
  - Export mensual para compliance

Blocklist:
  - Mantener tabla players_blocklist
  - Sincronizar con fuente externa cada 12h
  - No enviar a teléfono en blocklist
```

---

## Plan de Deployment

### Entornos

```
┌──────────────────┐
│   Development    │  Local laptop / staging
├──────────────────┤
│   Staging        │  Pre-production (replica de prod)
├──────────────────┤
│   Production     │  En vivo
└──────────────────┘
```

### Infrastructure as Code

```yaml
# docker-compose.yml
services:
  n8n:
    image: n8nio/n8n:latest
    environment:
      - DB_TYPE=postgres
      - DB_HOST=postgres
      - DB_NAME=n8n
  
  postgres:
    image: postgres:15-alpine
    volumes:
      - ./db/schema/:/docker-entrypoint-initdb.d/
    
  redis:
    image: redis:7-alpine
```

### CI/CD Pipeline

```yaml
Trigger: git push a dev/main

Stage 1: Lint
  - Validar SQL syntax
  - Verificar secrets no commiteados

Stage 2: Test
  - Unit tests de helpers/validators
  - Integration tests con PostgreSQL mock

Stage 3: Build
  - Build Docker image
  - Push a registry (ECR/DockerHub)

Stage 4: Deploy
  - Staging: docker-compose up
  - Validar health checks
  - Manual approval para Prod
  - Production: blue-green deployment
  - Smoke tests post-deployment

Rollback:
  - Si error post-deploy → revert a última imagen
```

### Checklist de Deployment

```markdown
Pre-deployment:
  - [ ] Código revisado (2 reviewers)
  - [ ] Tests pasando (100% coverage en changed files)
  - [ ] Migrations en /db/migrations/ numeradas
  - [ ] Secrets rotados (si aplicable)
  - [ ] Runbook de rollback preparado
  - [ ] Status page updated

Deployment:
  - [ ] Backup de PostgreSQL
  - [ ] Deploy a staging primero
  - [ ] Validar health checks (99% uptime)
  - [ ] Ejecutar smoke tests
  - [ ] Merge a main
  - [ ] Deploy a production
  - [ ] Monitor error logs (5 min post-deploy)

Post-deployment:
  - [ ] Confirmar con operaciones (chat)
  - [ ] Documentar cambios realizados en CHANGELOG
  - [ ] Archivar logs de deployment
```

---

## Roadmap Técnico (Mapping con Fases de Negocio)

| Fase | Hitos Técnicos | Tablas Nuevas | Workflows Nuevos | Integraciones |
|------|---|---|---|---|
| **Fase 1: MVP** | Schema base, n8n setup, Evolution API adapter | players, whatsapp_messages, templates, executions | 5 workflows (onboarding, pagos, FAQ) | Evolution API |
| **Fase 2: Retención** | Segmentation engine, timestamp tracking | transactions, offers | 5 workflows (inactivity, birthday, bonus) | - |
| **Fase 3: Risk** | Rule engine, agregados diarios | risk_flags, aggregated_metrics | 4 workflows (abuse detection, multi-account) | Compliance API (futura) |
| **Fase 4: Reporting** | Dashboards Metabase, exports diarios | - | 2 workflows (reportes, alertas) | Slack, Email |

---

## Referencias

- [n8n Documentation](https://docs.n8n.io)
- [PostgreSQL JSONB](https://www.postgresql.org/docs/current/datatype-json.html)
- [Evolution API Docs](https://evolution-api.gitbook.io/)
- [iGaming Compliance (LATAM)](docs/architecture/compliance-guide.md) ← Por crear
- [Conventions](conventions.md)

---

**Documento viviente:** Actualizar con nuevas decisiones, trade-offs y lecciones aprendidas en cada fase.

Preguntas? → Crear issue en repositorio con tag `architecture`.
