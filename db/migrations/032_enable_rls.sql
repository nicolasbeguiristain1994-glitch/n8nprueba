-- Migration 032: Enable Row-Level Security on all public tables
-- Motivo: Supabase detectó que todas las tablas son accesibles públicamente
--         (rls_disabled_in_public). Habilitar RLS bloquea el acceso con la
--         anon key sin afectar el backend, que usa service_role (que bypasses RLS).
-- Idempotent: ALTER TABLE ... ENABLE ROW LEVEL SECURITY es idempotente en Postgres.

-- ============================================================
-- Core schema (init.sql)
-- ============================================================
ALTER TABLE contacts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_executions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_flags            ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregated_metrics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_workflows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE deduplication_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags          ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 001: WhatsApp lines
-- ============================================================
ALTER TABLE whatsapp_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_metrics    ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 003: Import logs
-- ============================================================
ALTER TABLE import_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 008: Campaign recipients
-- ============================================================
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 008c: Contact lists
-- ============================================================
ALTER TABLE contact_lists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_list_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 016: Users (RBAC)
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 023: Multi-line distributor
-- ============================================================
ALTER TABLE line_usage_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 024: Proxies
-- ============================================================
ALTER TABLE proxies                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_proxy_assignment_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 025: Casino players
-- ============================================================
ALTER TABLE casino_players ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Migration 028: Casino transactions
-- ============================================================
ALTER TABLE casino_transactions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- NOTA: No se agregan policies intencionalmente.
-- Con RLS habilitado y sin policies, la anon key no puede
-- leer ni escribir ninguna tabla (comportamiento deseado).
-- El backend usa SUPABASE_SERVICE_ROLE_KEY que bypasses RLS,
-- por lo que no se ve afectado.
-- ============================================================
