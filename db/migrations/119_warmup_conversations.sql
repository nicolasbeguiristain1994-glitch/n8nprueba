-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 119 — Conversaciones reales entre líneas (Warmup v3)
--
-- En lugar de mensajes genéricos de un pool, las propias líneas se hablan
-- entre sí usando guiones cargados por el usuario. El motor ejecuta cada paso
-- en orden estricto (turn-based), respeta bursts humanos y distribuye
-- conversaciones progresivamente según la semana de calentamiento.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Guiones cargados por el usuario ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS warmup_scripts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  description TEXT,
  total_steps INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Pasos de cada guión ───────────────────────────────────────────────────
-- Un paso es un mensaje de un participante (speaker_alias) en el guión.
-- Pasos consecutivos del mismo alias → burst (delay corto entre ellos).
-- Cambio de alias → turno (delay largo, simula lectura + escritura).

CREATE TABLE IF NOT EXISTS warmup_script_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id     UUID NOT NULL REFERENCES warmup_scripts(id) ON DELETE CASCADE,
  step_order    INT  NOT NULL,
  speaker_alias TEXT NOT NULL,
  content       TEXT NOT NULL,
  UNIQUE (script_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_wss_script_order
  ON warmup_script_steps (script_id, step_order);

-- ── 3. Ejecuciones activas de un guión entre dos líneas ──────────────────────
-- Una conversación es una instancia de un script asignada a un par de líneas.
-- alias_a / alias_b mapean los aliases del script a line_a / line_b.
--
-- Estados:
--   pending     → creada, esperando next_send_at (o envío inmediato)
--   in_progress → al menos un paso enviado, esperando next_send_at
--   completed   → todos los pasos enviados
--   failed      → fallo irrecuperable (ban, línea eliminada, etc.)
--   paused      → al menos una línea fue pausada/baneada manualmente

CREATE TABLE IF NOT EXISTS warmup_conversations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id       UUID        NOT NULL REFERENCES warmup_scripts(id) ON DELETE CASCADE,
  line_a_id       UUID        NOT NULL REFERENCES warmup_numbers(id) ON DELETE CASCADE,
  line_b_id       UUID        NOT NULL REFERENCES warmup_numbers(id) ON DELETE CASCADE,
  alias_a         TEXT        NOT NULL,
  alias_b         TEXT        NOT NULL,
  current_step    INT         NOT NULL DEFAULT 1,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','completed','failed','paused')),
  next_send_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  messages_sent   INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wc_different_lines CHECK (line_a_id <> line_b_id)
);

-- Índice principal: conversaciones listas para enviar (status + next_send_at)
CREATE INDEX IF NOT EXISTS idx_wc_status_ready
  ON warmup_conversations (next_send_at ASC NULLS FIRST)
  WHERE status IN ('pending', 'in_progress');

-- Lookup por línea (para saber cuántas conversaciones activas tiene una línea)
CREATE INDEX IF NOT EXISTS idx_wc_line_a ON warmup_conversations (line_a_id);
CREATE INDEX IF NOT EXISTS idx_wc_line_b ON warmup_conversations (line_b_id);

-- ── 4. RPC: get_ready_conversations ─────────────────────────────────────────
-- Retorna conversaciones listas para procesar con datos de ambas líneas.
-- FOR UPDATE OF wc SKIP LOCKED garantiza que dos invocaciones concurrentes
-- del motor (n8n corre cada 15 min) no procesen la misma conversación.

CREATE OR REPLACE FUNCTION get_ready_conversations(p_limit INT DEFAULT 20)
RETURNS TABLE (
  -- conversación
  conv_id             UUID,
  script_id           UUID,
  line_a_id           UUID,
  line_b_id           UUID,
  alias_a             TEXT,
  alias_b             TEXT,
  current_step        INT,
  conv_status         TEXT,
  next_send_at        TIMESTAMPTZ,
  messages_sent       INT,
  -- línea A
  line_a_instance     TEXT,
  line_a_phone        TEXT,
  line_a_status       TEXT,
  line_a_evo_url      TEXT,
  line_a_current_day  INT,
  -- línea B
  line_b_instance     TEXT,
  line_b_phone        TEXT,
  line_b_status       TEXT,
  line_b_evo_url      TEXT,
  line_b_current_day  INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    wc.id,
    wc.script_id,
    wc.line_a_id,
    wc.line_b_id,
    wc.alias_a::text,
    wc.alias_b::text,
    wc.current_step,
    wc.status::text,
    wc.next_send_at,
    wc.messages_sent,
    -- línea A
    la.instance_name::text,
    la.phone_number::text,
    la.warmup_status::text,
    la.evolution_url::text,
    la.current_day,
    -- línea B
    lb.instance_name::text,
    lb.phone_number::text,
    lb.warmup_status::text,
    lb.evolution_url::text,
    lb.current_day
  FROM  warmup_conversations wc
  JOIN  warmup_numbers       la ON la.id = wc.line_a_id
  JOIN  warmup_numbers       lb ON lb.id = wc.line_b_id
  WHERE wc.status IN ('pending', 'in_progress')
    AND (wc.next_send_at IS NULL OR wc.next_send_at <= NOW())
  ORDER BY wc.next_send_at ASC NULLS FIRST
  LIMIT p_limit
  FOR UPDATE OF wc SKIP LOCKED;
END;
$$;
