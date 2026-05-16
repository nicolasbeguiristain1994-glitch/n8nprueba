BEGIN;

-- ── Módulo de Priorización de Contactos para Campañas de Reactivación ─────────
--
-- Diseño: enfoque Tier-First.
--   1. El tier de valor (derivado de segment o monto) determina la ventana de
--      inactividad elegible y el segmento de difusión de salida.
--   2. El priority_score ordena contactos DENTRO de un segmento (0–100).
--      Descomposición: value_score(0–60) + urgency_score(0–40).
--   3. Los operadores filtran por reactivation_segment para elegir lista + template.
--
-- El cómputo es idempotente (UPSERT por contact_id) y se ejecuta en batch.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_priority_scores (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      UUID         NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- ── Score compuesto (0–100) ───────────────────────────────────────────────
  -- Usado para ordenar contactos dentro de un mismo reactivation_segment.
  priority_score  NUMERIC(5,2) NOT NULL DEFAULT 0,

  -- ── Segmento de difusión de salida ───────────────────────────────────────
  -- NULL si el contacto no es elegible para ningún segmento.
  reactivation_segment TEXT CHECK (reactivation_segment IN (
    'REACTIVACION_URGENTE',
    'REACTIVACION_PRIORITARIA',
    'REACTIVACION_ESTANDAR',
    'REACTIVACION_FRIA'
  )),

  -- ── Tier de valor del contacto (en el momento del cómputo) ───────────────
  value_tier  TEXT NOT NULL DEFAULT 'bajo'
              CHECK (value_tier IN ('vip', 'alto', 'medio', 'bajo')),

  -- ── Desglose del score ────────────────────────────────────────────────────
  value_score    SMALLINT NOT NULL DEFAULT 0,  -- 0–60: LTV del tier
  urgency_score  SMALLINT NOT NULL DEFAULT 0,  -- 0–40: posición en ventana del tier

  -- ── Métricas snapshot (en el momento del cómputo) ─────────────────────────
  days_inactive       INTEGER,
  deposit_segment     TEXT,         -- contacts.segment en el momento del cómputo
  total_deposit_amount NUMERIC(14,2), -- contacts.total_deposit_amount (si disponible)

  -- ── Elegibilidad ─────────────────────────────────────────────────────────
  is_eligible   BOOLEAN  NOT NULL DEFAULT false,
  skip_reasons  TEXT[]   NOT NULL DEFAULT '{}',

  -- ── Metadata ─────────────────────────────────────────────────────────────
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(contact_id)
);

COMMENT ON TABLE contact_priority_scores IS
  'Scores de priorización Tier-First para campañas de reactivación. Recomputado nocturnamente.';
COMMENT ON COLUMN contact_priority_scores.reactivation_segment IS
  'Segmento de difusión. NULL = no elegible. Valores: REACTIVACION_{URGENTE,PRIORITARIA,ESTANDAR,FRIA}';
COMMENT ON COLUMN contact_priority_scores.priority_score IS
  'Score 0–100 = value_score(0–60) + urgency_score(0–40). Ordena dentro de reactivation_segment.';
COMMENT ON COLUMN contact_priority_scores.urgency_score IS
  'Decae linealmente desde 40 (inicio de ventana) hasta 0 (fin de ventana del tier).';

-- ── Índices ───────────────────────────────────────────────────────────────────

-- Consulta principal del operador: elegibles por segmento, ordenados por score
CREATE INDEX IF NOT EXISTS idx_cps_segment_score
  ON contact_priority_scores (reactivation_segment, priority_score DESC)
  WHERE is_eligible = true;

-- Listado global de elegibles
CREATE INDEX IF NOT EXISTS idx_cps_eligible_score
  ON contact_priority_scores (priority_score DESC)
  WHERE is_eligible = true;

-- Detección de scores stale para recompute selectivo
CREATE INDEX IF NOT EXISTS idx_cps_computed_at
  ON contact_priority_scores (computed_at DESC);

COMMIT;
