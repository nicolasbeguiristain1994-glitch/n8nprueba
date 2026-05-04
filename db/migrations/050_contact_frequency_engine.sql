-- Migration 050: ContactFrequencyEngine
--
-- Implementa el control de frecuencia de envíos por contacto.
-- Objetivo: garantizar que ningún contacto reciba más de 1 mensaje/día y
-- 2 mensajes/semana, protegiéndonos de reportes de spam y baneos de WhatsApp.
--
-- Dos tablas nuevas:
--   contact_frequency_rules  — reglas configurables por operador y/o segmento
--   contact_send_history     — historial inmutable de envíos por contacto
--
-- Diseño:
--   ─ scope_key (GENERATED ALWAYS AS STORED) en contact_frequency_rules permite
--     ON CONFLICT upsert limpio sin necesidad de índices de expresión complejos.
--   ─ contact_send_history usa ventanas rolling (no calendario) para mayor
--     conservadorismo: "hoy" = últimas 24h, "semana" = últimos 7 días.
--   ─ campaign_recipient_id UNIQUE garantiza idempotencia: un recipient = un registro.
--   ─ Índice de rango (contact_id, sent_at DESC) cubre la query crítica de evaluación.
--
-- Additive: no modifica tablas existentes.
-- Idempotente: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS en todo.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TABLA: contact_frequency_rules
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Cada fila define los límites de envío para una combinación de contexto.
-- El motor busca la regla más específica que aplique al contacto:
--   operator_id + seg_monto + seg_actividad → mayor especificidad
--   NULL en cualquier campo                → comodín (aplica a cualquier valor)
--   Todos NULL                             → regla global fallback

CREATE TABLE IF NOT EXISTS contact_frequency_rules (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope de la regla. NULL = comodín.
  operator_id     UUID          REFERENCES users(id) ON DELETE CASCADE,
  seg_monto       VARCHAR(20)   CHECK (seg_monto     IN ('bajo','medio','alto','vip')),
  seg_actividad   VARCHAR(20)   CHECK (seg_actividad IN ('nuevo','frecuente','regular','ocasional','en_riesgo','inactivo')),

  -- Clave de scope normalizada para ON CONFLICT upsert limpio.
  -- Convierte NULLs a valores centinela → unicidad garantizada incluso con NULLs.
  scope_key       TEXT          GENERATED ALWAYS AS (
                                  COALESCE(operator_id::text, '__global__') || '|' ||
                                  COALESCE(seg_monto,         '__any__')    || '|' ||
                                  COALESCE(seg_actividad,     '__any__')
                                ) STORED NOT NULL,

  -- Límites de frecuencia (NOT NULL → siempre hay valores explícitos).
  max_per_day             SMALLINT    NOT NULL DEFAULT 1
                                      CHECK (max_per_day > 0),
  max_per_week            SMALLINT    NOT NULL DEFAULT 2
                                      CHECK (max_per_week >= max_per_day),
  min_hours_between_sends SMALLINT    NOT NULL DEFAULT 48
                                      CHECK (min_hours_between_sends >= 0),

  -- Estado
  is_active       BOOLEAN       NOT NULL DEFAULT true,

  -- Auditoría
  created_by      UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Unicidad de scope: solo puede existir una regla activa por combinación.
-- ON CONFLICT (scope_key) permite upsert limpio desde el repositorio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_frequency_rules_scope_key
  ON contact_frequency_rules (scope_key);

-- Índice para cargar reglas por operador (path de evaluación: filtro principal).
CREATE INDEX IF NOT EXISTS idx_contact_frequency_rules_operator
  ON contact_frequency_rules (operator_id)
  WHERE is_active = true;

COMMENT ON TABLE contact_frequency_rules IS
  'Reglas configurables de frecuencia de envío por operador y/o segmento de jugador. '
  'La regla más específica (mayor número de campos non-null) tiene precedencia. '
  'NULL en operator_id/seg_monto/seg_actividad actúa como comodín. '
  'Gestionado por ContactFrequencyRulesRepository.';

COMMENT ON COLUMN contact_frequency_rules.scope_key IS
  'Clave de unicidad generada. Convierte NULLs a centinelas (__global__, __any__) '
  'para garantizar unicidad sin índices de expresión complejos. '
  'No leer directamente — es un artefacto de implementación.';

COMMENT ON COLUMN contact_frequency_rules.max_per_day IS
  'Máximo de mensajes permitidos en las últimas 24 horas (ventana rolling, no calendario).';

COMMENT ON COLUMN contact_frequency_rules.max_per_week IS
  'Máximo de mensajes permitidos en los últimos 7 días (ventana rolling, no calendario).';

COMMENT ON COLUMN contact_frequency_rules.min_hours_between_sends IS
  'Horas mínimas recomendadas entre envíos consecutivos. '
  'Valor 0 = sin restricción de cool-down.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. TABLA: contact_send_history
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Registro inmutable de cada mensaje enviado exitosamente a un contacto.
-- Fuente de verdad para calcular contadores de frecuencia en evaluaciones.
--
-- Diseño de idempotencia:
--   campaign_recipient_id UNIQUE garantiza que un retry de handleSuccess()
--   no crea un doble registro en el historial. ON CONFLICT DO NOTHING.
--
-- Retención: no se eliminan filas. Las queries de evaluación filtran por
--   sent_at >= NOW() - INTERVAL '7 days' para mantener performance.

CREATE TABLE IF NOT EXISTS contact_send_history (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Quién recibió el mensaje
  contact_id    UUID          NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  phone_number  TEXT          NOT NULL,

  -- Contexto del envío
  campaign_id   UUID          REFERENCES campaigns(id)           ON DELETE SET NULL,
  operator_id   UUID          REFERENCES users(id)               ON DELETE SET NULL,

  -- Vínculo con el sistema de recipients (garantiza idempotencia)
  -- NULL solo para envíos manuales o tests.
  campaign_recipient_id UUID  REFERENCES campaign_recipients(id) ON DELETE SET NULL,

  -- Cuándo se envió (fuente de verdad para ventanas rolling)
  sent_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Índices ───────────────────────────────────────────────────────────────────

-- Índice principal: cubre la query crítica de evaluación.
-- La query filtra por contact_id y sent_at >= NOW() - 7 days,
-- luego agrega COUNT y MAX en un solo pass.
CREATE INDEX IF NOT EXISTS idx_contact_send_history_contact_sent_at
  ON contact_send_history (contact_id, sent_at DESC);

-- Idempotencia: un campaign_recipient_id → máximo un registro en el historial.
-- WHERE IS NOT NULL: no aplica a envíos manuales (NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_send_history_recipient_id
  ON contact_send_history (campaign_recipient_id)
  WHERE campaign_recipient_id IS NOT NULL;

-- Para auditoría y limpieza futura (TTL por campaña).
CREATE INDEX IF NOT EXISTS idx_contact_send_history_campaign
  ON contact_send_history (campaign_id)
  WHERE campaign_id IS NOT NULL;

-- Para auditoría por operador.
CREATE INDEX IF NOT EXISTS idx_contact_send_history_operator
  ON contact_send_history (operator_id)
  WHERE operator_id IS NOT NULL;

COMMENT ON TABLE contact_send_history IS
  'Registro inmutable de mensajes enviados exitosamente a cada contacto. '
  'Fuente de verdad para el ContactFrequencyEngine al calcular ventanas rolling. '
  'Insertar solo DESPUÉS de confirmar envío exitoso (Evolution API 200). '
  'Gestionado por ContactSendHistoryRepository.';

COMMENT ON COLUMN contact_send_history.sent_at IS
  'Momento del envío confirmado. Ventana rolling: '
  '"hoy" = sent_at >= NOW() - 24h, "semana" = sent_at >= NOW() - 7 days.';

COMMENT ON COLUMN contact_send_history.campaign_recipient_id IS
  'FK a campaign_recipients. UNIQUE WHERE NOT NULL garantiza idempotencia: '
  'ON CONFLICT DO NOTHING si handleSuccess() se llama dos veces por el mismo recipient.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. TRIGGER: updated_at automático en contact_frequency_rules
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_contact_frequency_rules_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contact_frequency_rules_updated_at
  ON contact_frequency_rules;

CREATE TRIGGER trg_contact_frequency_rules_updated_at
  BEFORE UPDATE ON contact_frequency_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_contact_frequency_rules_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. REGLA GLOBAL POR DEFECTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Garantiza que siempre exista al menos una regla fallback aunque no se
-- configure nada. Los valores reflejan el límite no-negociable del negocio:
--   max_per_day=1, max_per_week=2, min_hours_between_sends=48.
--
-- ON CONFLICT DO NOTHING: idempotente, re-ejecutable sin efectos secundarios.

INSERT INTO contact_frequency_rules
  (operator_id, seg_monto, seg_actividad, max_per_day, max_per_week, min_hours_between_sends, is_active)
VALUES
  (NULL, NULL, NULL, 1, 2, 48, true)
ON CONFLICT (scope_key) DO NOTHING;
