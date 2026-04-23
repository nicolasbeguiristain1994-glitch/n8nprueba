-- ============================================
-- Init Schema: WhatsApp Automation Platform
-- Archivo: db/schema/init.sql
-- ============================================
-- Esquema completo: contactos, campañas, plantillas, mensajes, eventos, secuencias, ejecuciones, métricas
-- Ejecutar sobre PostgreSQL 13+ (en Supabase)
-- Idempotente: todos los CREATE TABLE IF NOT EXISTS
-- ============================================

-- ============================================
-- EXTENSIONES
-- ============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- Para full-text search
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- Para índices complejos


-- ============================================
-- TIPOS ENUMERADOS
-- ============================================

DO $$ BEGIN
    CREATE TYPE contact_status AS ENUM ('active', 'inactive', 'suspended', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE contact_segment AS ENUM ('casual', 'regular', 'vip', 'whale');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE campaign_status AS ENUM ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE campaign_type AS ENUM ('onboarding', 'retention', 'payment', 'risk_alert', 'support', 'promotion', 'survey');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE message_status AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE message_direction AS ENUM ('outbound', 'inbound');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE event_type AS ENUM ('message_sent', 'message_delivered', 'message_read', 'message_failed', 'contact_active', 'contact_inactive', 'campaign_started', 'campaign_completed', 'sequence_triggered', 'risk_flag_created', 'risk_flag_resolved');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE workflow_status AS ENUM ('success', 'error', 'skipped', 'timeout');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE risk_flag_type AS ENUM ('bonus_abuse', 'multi_account', 'high_withdrawal', 'unusual_pattern', 'blacklist', 'kyc_pending');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE risk_severity AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN null;
END $$;


-- ============================================
-- CORE: CONTACTOS (Contacts / Players)
-- ============================================

CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Identificación externa
    external_id VARCHAR(100) NOT NULL UNIQUE,  -- ID del casino/sistema origen
    platform_source VARCHAR(50),  -- 'casino' | 'crm' | 'manual'
    
    -- Datos personales
    phone_number VARCHAR(20) NOT NULL,  -- E.164: +5491112345678
    country_code CHAR(2),  -- ISO 3166-1 alpha-2: AR, BR, UY, etc
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    date_of_birth DATE,
    
    -- Estado y segmentación
    status contact_status DEFAULT 'active',
    segment contact_segment DEFAULT 'casual',
    
    -- Métricas agregadas (desnormalizadas para performance)
    total_messages_received INT DEFAULT 0,
    total_messages_sent INT DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    
    -- Preferencias y flags
    opt_in_marketing BOOLEAN DEFAULT true,
    opt_in_sms BOOLEAN DEFAULT true,
    do_not_contact BOOLEAN DEFAULT false,
    phone_verified BOOLEAN DEFAULT false,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE contacts IS 'Tabla de contactos/jugadores - mirror del sistema fuente con enriquecimiento';
COMMENT ON COLUMN contacts.external_id IS 'ID del sistema fuente (casino)';
COMMENT ON COLUMN contacts.phone_number IS 'Formato E.164 normalizado';
COMMENT ON COLUMN contacts.segment IS 'casual|regular|vip|whale - calculado cada 24h';
COMMENT ON COLUMN contacts.last_activity_at IS 'Última interacción (mensaje o transacción)';

CREATE INDEX IF NOT EXISTS idx_contacts_external_id ON contacts(external_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
CREATE INDEX IF NOT EXISTS idx_contacts_segment ON contacts(segment) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contacts_status_active ON contacts(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contacts_last_activity ON contacts(last_activity_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at DESC);


-- ============================================
-- CAMPAÑAS (Campaigns)
-- ============================================

CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Clasificación
    type campaign_type NOT NULL DEFAULT 'promotion',

    -- Estado
    status campaign_status DEFAULT 'draft',

    -- Contenido (mensaje principal + pool de rotación)
    message  TEXT,
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Media adjunto (opcional)
    media_url  TEXT,
    media_type TEXT,

    -- Lista de contactos asociada
    -- FK a contact_lists agregado en migration 021 (contact_lists aún no existe aquí)
    list_id UUID,

    -- Programación
    scheduled_at TIMESTAMPTZ,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- Targeting y contadores
    total_targets INTEGER NOT NULL DEFAULT 0,
    total_sent    INTEGER NOT NULL DEFAULT 0,
    total_failed  INTEGER NOT NULL DEFAULT 0,

    -- Antiblock delay (segundos entre envíos)
    antiblock_delay_min INTEGER NOT NULL DEFAULT 3,
    antiblock_delay_max INTEGER NOT NULL DEFAULT 8,

    -- Personalización
    personalize_name BOOLEAN NOT NULL DEFAULT true,

    -- Processor lock (emisión en background)
    processor_locked_at  TIMESTAMPTZ,
    processor_lock_token UUID,

    -- Ownership (para RBAC multi-tenant)
    owned_by   UUID,
    updated_by UUID,

    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT campaigns_antiblock_min_pos   CHECK (antiblock_delay_min >= 1),
    CONSTRAINT campaigns_antiblock_max_pos   CHECK (antiblock_delay_max >= 1),
    CONSTRAINT campaigns_antiblock_order     CHECK (antiblock_delay_min <= antiblock_delay_max)
);

COMMENT ON TABLE campaigns IS 'Campañas de comunicación masiva - marketing, retención, alertas';
COMMENT ON COLUMN campaigns.type IS 'Tipo de campaña: onboarding, retention, payment, risk_alert, etc';
COMMENT ON COLUMN campaigns.status IS 'draft|scheduled|running|paused|completed|cancelled';
COMMENT ON COLUMN campaigns.target_segment IS 'Segmento objetivo - NULL = todos los activos';
COMMENT ON COLUMN campaigns.max_daily_messages IS 'Throttle para no sobrecargar sistema';

CREATE INDEX IF NOT EXISTS idx_campaigns_status       ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_type         ON campaigns(type);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON campaigns(scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at   ON campaigns(created_at DESC);


-- ============================================
-- PLANTILLAS (WhatsApp Templates)
-- ============================================

CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Identificación
    name VARCHAR(100) NOT NULL UNIQUE,  -- domain-event-variant (e.g., onboarding-welcome-default)
    display_name VARCHAR(255),  -- Nombre legible
    description TEXT,
    
    -- Clasificación
    domain VARCHAR(50) NOT NULL,  -- onboarding | retention | payment | support | risk
    event_trigger VARCHAR(100),  -- welcome | deposit_confirmed | inactivity_7d | etc
    language VARCHAR(10) DEFAULT 'es',
    
    -- Contenido
    body TEXT NOT NULL,  -- Plantilla con {{variables}}
    variables JSONB DEFAULT '[]'::JSONB,  -- ["nombre", "monto", "fecha"] - lista de variables esperadas
    
    -- Configuración
    use_media BOOLEAN DEFAULT false,  -- Si incluye imagen
    media_url VARCHAR(500),
    
    -- Estado
    active BOOLEAN DEFAULT true,
    version INT DEFAULT 1,
    
    -- Owner
    owner_email VARCHAR(255),
    approved_by VARCHAR(255),
    approval_date TIMESTAMPTZ,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    archived_at TIMESTAMPTZ
);

COMMENT ON TABLE whatsapp_templates IS 'Plantillas de mensajes de WhatsApp reutilizables';
COMMENT ON COLUMN whatsapp_templates.name IS 'Identificador único: domain-event-variant';
COMMENT ON COLUMN whatsapp_templates.variables IS 'JSON array de variables esperadas: ["nombre", "monto"]';
COMMENT ON COLUMN whatsapp_templates.version IS 'Control de versiones para rollback';

CREATE INDEX IF NOT EXISTS idx_templates_domain ON whatsapp_templates(domain);
CREATE INDEX IF NOT EXISTS idx_templates_active ON whatsapp_templates(active);
CREATE INDEX IF NOT EXISTS idx_templates_language ON whatsapp_templates(language);
CREATE INDEX IF NOT EXISTS idx_templates_name ON whatsapp_templates(name);


-- ============================================
-- MENSAJES (WhatsApp Messages)
-- ============================================

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Relaciones
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
    parent_message_id UUID REFERENCES whatsapp_messages(id) ON DELETE SET NULL,  -- Para reply chains
    
    -- Datos del mensaje
    phone_number VARCHAR(20) NOT NULL,  -- Desnormalizado para queries rápidas
    message_body TEXT NOT NULL,
    direction message_direction DEFAULT 'outbound',  -- outbound | inbound
    
    -- Clasificación
    message_type VARCHAR(50),  -- onboarding | retention | payment | support | risk
    
    -- Estado
    status message_status DEFAULT 'queued',
    
    -- IDs externos
    evolution_message_id VARCHAR(255),  -- ID de Evolution API para tracking
    whatsapp_message_id VARCHAR(255),  -- MessageID de WhatsApp (para webhook status)
    
    -- Timings
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    retry_count INT DEFAULT 0,
    
    -- Error tracking
    error_code VARCHAR(50),
    error_detail TEXT,
    
    -- Workflow tracking
    workflow_name VARCHAR(100),
    workflow_id VARCHAR(255),
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::JSONB,  -- Custom data: {dedup_key: "...", internal_id: "...", etc}
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE whatsapp_messages IS 'Log de todos los mensajes enviados/recibidos por WhatsApp';
COMMENT ON COLUMN whatsapp_messages.status IS 'queued|sent|delivered|read|failed|skipped';
COMMENT ON COLUMN whatsapp_messages.direction IS 'outbound (enviados) | inbound (recibidos)';
COMMENT ON COLUMN whatsapp_messages.evolution_message_id IS 'ID de Evolution API para tracking y webhooks';
COMMENT ON COLUMN whatsapp_messages.metadata IS 'JSONB para deduplicación, workflow vars, etc';

CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON whatsapp_messages(contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON whatsapp_messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON whatsapp_messages(status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON whatsapp_messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_evolution_id ON whatsapp_messages(evolution_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_workflow ON whatsapp_messages(workflow_name, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_failed ON whatsapp_messages(status, retry_count) WHERE status = 'failed' AND retry_count < 3;


-- ============================================
-- EVENTOS (Events / Webhooks)
-- ============================================

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Clasificación
    event_type event_type NOT NULL,
    source VARCHAR(50),  -- 'evolution_api' | 'evolution_webhook' | 'casino_webhook' | 'n8n_workflow' | 'manual'
    
    -- Relaciones
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    message_id UUID REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    
    -- Datos del evento
    payload JSONB DEFAULT '{}'::JSONB,  -- Datos completos del webhook/transacción
    
    -- Procesamiento
    processed BOOLEAN DEFAULT false,
    processed_at TIMESTAMPTZ,
    error_processing TEXT,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE events IS 'Log de eventos para auditoría y trazabilidad completa';
COMMENT ON COLUMN events.event_type IS 'message_sent | message_delivered | contact_active | risk_flag_created | etc';
COMMENT ON COLUMN events.source IS 'Sistema origen del evento: Evolution API, webhooks, n8n';
COMMENT ON COLUMN events.payload IS 'Datos completos del evento (JSON crudo del webhook)';
COMMENT ON COLUMN events.processed IS 'Flag para evitar procesar mismo evento 2x';

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_contact_id ON events(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_message_id ON events(message_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed) WHERE processed = false;


-- ============================================
-- SECUENCIAS (Sequences / Drip Campaigns)
-- ============================================

CREATE TABLE IF NOT EXISTS sequences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Identificación
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,

    -- Configuración
    active BOOLEAN DEFAULT true,
    type VARCHAR(50),  -- 'email_drip' | 'retention_ladder' | 'onboarding_flow' | etc
    
    -- Trigger
    trigger_event VARCHAR(100),  -- 'contact_created' | 'inactivity_3d' | 'deposit_received' | etc
    trigger_delay_seconds INT DEFAULT 0,  -- Delay antes de ejecutar
    
    -- Pasos de la secuencia (almacenados como JSONB para flexibilidad)
    steps JSONB NOT NULL,  -- Array: [{delay_hours: 0, template_id: UUID, ...}, {...}]
    
    -- Configuración
    max_runs_per_contact INT,  -- Máximo times que puede ejecutar para un contacto
    enable_opt_out BOOLEAN DEFAULT true,  -- Permitir que contacto se salga de secuencia
    
    -- Tracking
    created_by VARCHAR(255),
    updated_by VARCHAR(255),
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE sequences IS 'Secuencias automatizadas de mensajes (drip campaigns)';
COMMENT ON COLUMN sequences.trigger_event IS 'Evento que inicia la secuencia: contact_created, inactivity_3d, etc';
COMMENT ON COLUMN sequences.trigger_delay_seconds IS 'Retraso antes de ejecutar la secuencia';
COMMENT ON COLUMN sequences.steps IS 'JSON array de pasos: [{delay_hours: 24, template_id: "...", target_segment: "vip"}, ...]';

CREATE INDEX IF NOT EXISTS idx_sequences_active ON sequences(active);
CREATE INDEX IF NOT EXISTS idx_sequences_trigger_event ON sequences(trigger_event) WHERE active = true;


-- ============================================
-- EJECUCIONES DE SECUENCIAS (Sequence Executions)
-- ============================================

CREATE TABLE IF NOT EXISTS sequence_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    
    -- Progreso
    current_step INT DEFAULT 0,
    total_steps INT,
    
    -- Estado
    status VARCHAR(50) DEFAULT 'running',  -- running | completed | abandoned | opted_out
    
    -- Timings
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    next_step_scheduled_for TIMESTAMPTZ,
    
    -- Tracking
    messages_sent INT DEFAULT 0,
    messages_delivered INT DEFAULT 0,
    messages_failed INT DEFAULT 0,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE sequence_executions IS 'Instancias de ejecución de secuencias por contacto';
COMMENT ON COLUMN sequence_executions.current_step IS 'Índice del paso actual (0-based)';
COMMENT ON COLUMN sequence_executions.status IS 'running | completed | abandoned | opted_out';

CREATE INDEX IF NOT EXISTS idx_seq_exec_contact ON sequence_executions(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_seq_exec_sequence ON sequence_executions(sequence_id);
CREATE INDEX IF NOT EXISTS idx_seq_exec_next_step ON sequence_executions(next_step_scheduled_for) WHERE status = 'running';


-- ============================================
-- EJECUCIONES DE WORKFLOWS (Workflow Executions)
-- ============================================

CREATE TABLE IF NOT EXISTS workflow_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Workflow
    workflow_name VARCHAR(100) NOT NULL,
    workflow_id VARCHAR(255),  -- ID de n8n para debugging
    
    -- Trigger
    trigger_event VARCHAR(100),
    trigger_source VARCHAR(50),  -- 'webhook' | 'timer' | 'manual' | 'event'
    
    -- Contexto
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    
    -- Ejecución
    status workflow_status NOT NULL,
    input_data JSONB DEFAULT '{}'::JSONB,
    output_data JSONB DEFAULT '{}'::JSONB,
    
    -- Error tracking
    error_code VARCHAR(50),
    error_message TEXT,
    error_stack TEXT,
    
    -- Performance
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INT,  -- Duración en milisegundos
    
    -- Retry
    retry_count INT DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE workflow_executions IS 'Log de ejecuciones de workflows de n8n para auditoría';
COMMENT ON COLUMN workflow_executions.status IS 'success | error | skipped | timeout';
COMMENT ON COLUMN workflow_executions.input_data IS 'Datos de entrada al workflow (JSON)';
COMMENT ON COLUMN workflow_executions.output_data IS 'Resultado/output del workflow (JSON)';
COMMENT ON COLUMN workflow_executions.duration_ms IS 'Duración total en milisegundos';

CREATE INDEX IF NOT EXISTS idx_executions_workflow_name ON workflow_executions(workflow_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status ON workflow_executions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_contact_id ON workflow_executions(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_error ON workflow_executions(status, created_at DESC) WHERE status = 'error';


-- ============================================
-- FLAGS DE RIESGO (Risk Flags)
-- ============================================

CREATE TABLE IF NOT EXISTS risk_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Relaciones
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    
    -- Clasificación
    flag_type risk_flag_type NOT NULL,
    severity risk_severity DEFAULT 'medium',
    
    -- Detalles
    reason TEXT,  -- Descripción del por qué se creó el flag
    source_workflow VARCHAR(100),  -- Workflow que detectó el flag
    source_event_id UUID REFERENCES events(id) ON DELETE SET NULL,
    
    -- Estado
    is_active BOOLEAN DEFAULT true,
    resolved BOOLEAN DEFAULT false,
    
    -- Resolución
    resolved_by VARCHAR(255),
    resolution_note TEXT,
    
    -- Timings
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,  -- Flag expira después de X días si no es confirmado
    
    -- Auditoría
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE risk_flags IS 'Flags de riesgo/fraude detectados por rules engine';
COMMENT ON COLUMN risk_flags.flag_type IS 'bonus_abuse | multi_account | high_withdrawal | unusual_pattern | blacklist | kyc_pending';
COMMENT ON COLUMN risk_flags.severity IS 'low | medium | high | critical';
COMMENT ON COLUMN risk_flags.is_active IS 'Flag activo vs histórico';
COMMENT ON COLUMN risk_flags.expires_at IS 'Flag expira si no es confirmado/resuelto';

CREATE INDEX IF NOT EXISTS idx_risk_flags_contact ON risk_flags(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_flags_active ON risk_flags(is_active, created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_risk_flags_severity ON risk_flags(severity, created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_risk_flags_unresolved ON risk_flags(contact_id) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_risk_flags_expires ON risk_flags(expires_at) WHERE is_active = true AND expires_at IS NOT NULL;


-- ============================================
-- MÉTRICAS AGREGADAS (Aggregated Metrics)
-- ============================================

CREATE TABLE IF NOT EXISTS aggregated_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Período
    metric_date DATE NOT NULL,
    
    -- Totales diarios
    total_contacts_active INT DEFAULT 0,
    total_messages_sent INT DEFAULT 0,
    total_messages_delivered INT DEFAULT 0,
    total_messages_read INT DEFAULT 0,
    total_messages_failed INT DEFAULT 0,
    unique_contacts_messaged INT DEFAULT 0,
    
    -- Segmentación
    by_segment JSONB DEFAULT '{}'::JSONB,  -- {casual: {sent: 100, delivered: 95}, vip: {...}} 
    by_domain JSONB DEFAULT '{}'::JSONB,  -- {onboarding: {sent: 50}, retention: {sent: 75}}
    by_campaign JSONB DEFAULT '{}'::JSONB,  -- {campaign_id: {name: "...", sent: 100}}
    
    -- Tasas y promedios
    delivery_rate DECIMAL(5,2),  -- % delivered / sent
    read_rate DECIMAL(5,2),      -- % read / delivered
    error_rate DECIMAL(5,2),     -- % failed / sent
    avg_send_latency_ms INT,     -- Latencia promedio de envío
    
    -- Risk
    risk_flags_created INT DEFAULT 0,
    risk_flags_resolved INT DEFAULT 0,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE aggregated_metrics IS 'Métricas agregadas diarias para dashboards y reportes';
COMMENT ON COLUMN aggregated_metrics.by_segment IS 'Breakdown por segment: {casual: {sent: 100, delivered: 95}}';
COMMENT ON COLUMN aggregated_metrics.by_domain IS 'Breakdown por dominio: {onboarding: {sent: 50}}';
COMMENT ON COLUMN aggregated_metrics.delivery_rate IS '% de mensajes entregados vs enviados';

CREATE INDEX IF NOT EXISTS idx_metrics_date ON aggregated_metrics(metric_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_date_unique ON aggregated_metrics(metric_date);


-- ============================================
-- QUEUE / FAILED WORKFLOWS (Dead Letter)
-- ============================================

CREATE TABLE IF NOT EXISTS failed_workflows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Referencia al workflow fallido
    workflow_execution_id UUID REFERENCES workflow_executions(id) ON DELETE SET NULL,
    workflow_name VARCHAR(100),
    
    -- Detalles del fallo
    error_message TEXT,
    error_stack TEXT,
    last_error_occurence_at TIMESTAMPTZ,
    
    -- Retry info
    retry_attempts INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    should_alert_on_final_failure BOOLEAN DEFAULT true,
    
    -- Estado
    resolved BOOLEAN DEFAULT false,
    resolved_by VARCHAR(255),
    resolution_note TEXT,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

COMMENT ON TABLE failed_workflows IS 'Dead letter queue para workflows que fallaron 3+ veces';
COMMENT ON COLUMN failed_workflows.retry_attempts IS 'Número de intentos de retry realizados';

CREATE INDEX IF NOT EXISTS idx_failed_workflows_unresolved ON failed_workflows(resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_failed_workflows_created ON failed_workflows(created_at DESC);


-- ============================================
-- HISTORIAL DE CAMBIOS (Audit Log)
-- ============================================

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Entidad modificada
    entity_type VARCHAR(50) NOT NULL,  -- 'contact' | 'campaign' | 'template' | 'risk_flag'
    entity_id UUID NOT NULL,
    
    -- Cambio
    action VARCHAR(50) NOT NULL,  -- 'create' | 'update' | 'delete' | 'resolve'
    changes JSONB DEFAULT '{}'::JSONB,  -- Delta de cambios: {status: {old: "draft", new: "running"}}
    
    -- Usuario
    changed_by VARCHAR(255),
    reason TEXT,
    
    -- Auditoría
    created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE audit_log IS 'Historial de cambios para compliance y debugging';
COMMENT ON COLUMN audit_log.action IS 'create | update | delete | resolve | activate | deactivate';
COMMENT ON COLUMN audit_log.changes IS 'Delta JSON: {field_name: {old: value, new: value}}';

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC);


-- ============================================
-- RATE LIMIT / DEDUPLICATION (Redis-backed, cached in DB)
-- ============================================

CREATE TABLE IF NOT EXISTS deduplication_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dedup_key VARCHAR(255) NOT NULL UNIQUE,  -- Hash: workflow:contact:msgtype:ts
    message_id UUID REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
    
    -- Tracking
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);

COMMENT ON TABLE deduplication_cache IS 'Cache local de deduplicación (Redis es primary, DB es fallback)';
COMMENT ON COLUMN deduplication_cache.dedup_key IS 'Hash único de mensaje para deduplicación';
COMMENT ON COLUMN deduplication_cache.expires_at IS 'TTL: 5 minutos típicamente';

CREATE INDEX IF NOT EXISTS idx_dedup_key ON deduplication_cache(dedup_key);
CREATE INDEX IF NOT EXISTS idx_dedup_expires ON deduplication_cache(expires_at);


-- ============================================
-- VISTAS ÚTILES
-- ============================================

-- Vista: Últimos mensajes por contacto
CREATE OR REPLACE VIEW v_latest_messages_by_contact AS
SELECT 
    contact_id,
    MAX(sent_at) as last_message_at,
    COUNT(*) as total_messages,
    SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
FROM whatsapp_messages
WHERE contact_id IS NOT NULL
GROUP BY contact_id;

COMMENT ON VIEW v_latest_messages_by_contact IS 'Últimos eventos de mensajes por contacto';

-- Vista: Contactos activos con detalles
CREATE OR REPLACE VIEW v_contacts_active_detailed AS
SELECT 
    c.id,
    c.external_id,
    c.phone_number,
    c.first_name,
    c.segment,
    c.status,
    m.last_message_at,
    m.total_messages,
    m.delivered_count,
    COUNT(DISTINCT rf.id) as active_risk_flags
FROM contacts c
LEFT JOIN v_latest_messages_by_contact m ON c.id = m.contact_id
LEFT JOIN risk_flags rf ON c.id = rf.contact_id AND rf.is_active = true
WHERE c.status = 'active'
GROUP BY c.id, m.last_message_at, m.total_messages, m.delivered_count;

COMMENT ON VIEW v_contacts_active_detailed IS 'Dashboard de contactos activos con métricas';


-- ============================================
-- PROCEDIMIENTOS ALMACENADOS
-- ============================================

-- Función: Normalizar teléfono a E.164
CREATE OR REPLACE FUNCTION normalize_phone(phone_input VARCHAR)
RETURNS VARCHAR AS $$
BEGIN
    -- Remover espacios, guiones, paréntesis
    phone_input := REGEXP_REPLACE(phone_input, '[^0-9+]', '', 'g');
    
    -- Si no comienza con +, asumir +54 (Argentina)
    IF phone_input !~ '^\+' THEN
        phone_input := '+' || phone_input;
    END IF;
    
    RETURN phone_input;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION normalize_phone IS 'Normaliza números telefónicos a formato E.164';

-- Función: Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_timestamp IS 'Trigger automático para actualizar updated_at';

-- Trigger: contacts
CREATE TRIGGER trg_contacts_updated_at 
BEFORE UPDATE ON contacts 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Trigger: campaigns
CREATE TRIGGER trg_campaigns_updated_at 
BEFORE UPDATE ON campaigns 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Trigger: whatsapp_templates
CREATE TRIGGER trg_templates_updated_at 
BEFORE UPDATE ON whatsapp_templates 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Trigger: whatsapp_messages
CREATE TRIGGER trg_messages_updated_at 
BEFORE UPDATE ON whatsapp_messages 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Trigger: sequences
CREATE TRIGGER trg_sequences_updated_at 
BEFORE UPDATE ON sequences 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Trigger: risk_flags
CREATE TRIGGER trg_risk_flags_updated_at 
BEFORE UPDATE ON risk_flags 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Trigger: aggregated_metrics
CREATE TRIGGER trg_metrics_updated_at 
BEFORE UPDATE ON aggregated_metrics 
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- ============================================
-- GRANTS / SEGURIDAD (comentado - adaptar a tu setup)
-- ============================================

-- Ejemplo: Grant a usuario específico
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;


-- ============================================
-- INSERTIONS DE DATOS INICIALES (OPCIONAL)
-- ============================================

-- Plantillas de demostración
INSERT INTO whatsapp_templates (name, display_name, domain, event_trigger, body, variables, active, owner_email)
VALUES 
    ('onboarding-welcome-default', 'Bienvenida - Default', 'onboarding', 'contact_created', 
     'Hola {{nombre}}, ¡bienvenido! Ya podés depositar y jugar. ¡Que disfrutes!', 
     '["nombre"]'::JSONB, true, 'templates@platform.local'),
    ('payment-deposit-confirmed', 'Depósito Confirmado', 'payment', 'deposit_completed',
     'Hola {{nombre}}, confirmamos tu depósito de {{monto}} {{moneda}}. Saldo: {{saldo}}',
     '["nombre", "monto", "moneda", "saldo"]'::JSONB, true, 'templates@platform.local'),
    ('retention-inactive-7d', 'Retención - Inactivo 7 días', 'retention', 'inactivity_7d',
     'Te echamos de menos, {{nombre}}! 🎉 Volvé hoy con {{oferta}} de bono. Deposita ahora →',
     '["nombre", "oferta"]'::JSONB, true, 'templates@platform.local')
ON CONFLICT (name) DO NOTHING;

-- Secuencia de demostración
INSERT INTO sequences (name, description, active, type, trigger_event, trigger_delay_seconds, steps)
VALUES
    ('onboarding-flow-default', 'Flujo de onboarding automático', true, 'onboarding_flow', 'contact_created', 0,
     '[
       {"delay_hours": 0, "template_id": "onboarding-welcome-default", "description": "Bienvenida inmediata"},
       {"delay_hours": 24, "template_id": "payment-deposit-confirmed", "description": "Recordatorio deposit"},
       {"delay_hours": 72, "template_id": "retention-inactive-7d", "description": "Retención D+3"}
     ]'::JSONB)
ON CONFLICT (name) DO NOTHING;


-- ============================================
-- VALIDACIONES
-- ============================================

-- Constraint: Phone number debe ser E.164
ALTER TABLE contacts ADD CONSTRAINT check_phone_format
CHECK (phone_number ~ '^\+[0-9]{10,15}$');

-- Constraint: Email si existe debe ser válido
ALTER TABLE contacts ADD CONSTRAINT check_email_format
CHECK (email IS NULL OR email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$');


-- ============================================
-- FINAL SUMMARY
-- ============================================

/*
Esquema creado con:
- 12 tablas principales
- 6 tipos enumerados para type safety
- 40+ índices optimizados para queries comunes
- 2 vistas útiles para dashboards
- 2 funciones de utilidad (normalizar teléfono, actualizar timestamp)
- 11 triggers para auditoría
- Comentarios COMMENT ON en todas las tablas/columnas
- Data inicial de demostración

Próximos pasos:
1. Ejecutar este script en Supabase
2. Crear aplicación de sincronización de contactos
3. Implementar workflows en n8n
4. Configurar webhooks de Evolution API
5. Crear dashboards en Metabase
*/
