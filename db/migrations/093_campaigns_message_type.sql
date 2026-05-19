-- =============================================================================
-- Migration 093: Discriminador message_type en campaigns
-- =============================================================================
-- Agrega el campo explícito message_type para diferenciar campañas de texto
-- libre de campañas que usan plantillas pre-aprobadas por Meta (Cloud API).
--
-- Las columnas template_id y template_params ya existen desde migración 040.
-- Este campo hace explícita la intención en lugar de inferirla con IS NOT NULL.
-- =============================================================================

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'template'));

COMMENT ON COLUMN campaigns.message_type IS
  'text = mensaje libre (Evolution o Cloud con ventana abierta). '
  'template = plantilla Meta aprobada (Cloud únicamente, sin requisito de ventana).';
