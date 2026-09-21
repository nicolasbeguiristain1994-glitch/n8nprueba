-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 120 — Módulo de Encuestas (MVP)
--
-- Dos tablas mínimas:
--
--   encuestas             — catálogo de encuestas. `questions` es un JSONB con la
--                           definición de cada pregunta (type/label/options/required).
--                           `slug` permite compartir varias en paralelo (ej: wa-julio).
--
--   encuesta_respuestas   — un registro por submit público. Guarda `answers` (JSONB),
--                           el `campaign` que llegó por query param, `ip_hash`
--                           (SHA-256 salted, no IP en claro) y campos reservados
--                           para la futura personalización por jugador
--                           (`contact_id`, `player_token`).
--
-- Todo raw SQL, sin ORM. Idempotente vía IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ── encuestas ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS encuestas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  questions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT encuestas_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  CONSTRAINT encuestas_questions_is_array CHECK (jsonb_typeof(questions) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_encuestas_active ON encuestas (is_active) WHERE is_active = true;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION set_encuestas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_encuestas_updated_at ON encuestas;
CREATE TRIGGER trg_encuestas_updated_at
  BEFORE UPDATE ON encuestas
  FOR EACH ROW
  EXECUTE FUNCTION set_encuestas_updated_at();

-- ── encuesta_respuestas ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS encuesta_respuestas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encuesta_id    UUID NOT NULL REFERENCES encuestas(id) ON DELETE CASCADE,

  -- Payload: mapa { <question_id>: <answer> }.
  -- El backend valida forma vs. la definición de la encuesta.
  answers        JSONB NOT NULL,

  -- Tracking (query params / cookies)
  campaign       TEXT,
  source         TEXT,

  -- Extensibilidad: links únicos por jugador (fase 2).
  -- contact_id se popula cuando el link se generó desde el CRM.
  contact_id     UUID REFERENCES contacts(id) ON DELETE SET NULL,
  player_token   TEXT,

  -- Privacidad: hash sha256 salteado — nunca IP en claro.
  ip_hash        TEXT,
  user_agent     TEXT,

  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT encuesta_resp_answers_is_object CHECK (jsonb_typeof(answers) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_encresp_encuesta      ON encuesta_respuestas (encuesta_id);
CREATE INDEX IF NOT EXISTS idx_encresp_submitted_at  ON encuesta_respuestas (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_encresp_campaign      ON encuesta_respuestas (campaign) WHERE campaign IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_encresp_contact       ON encuesta_respuestas (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_encresp_player_token  ON encuesta_respuestas (player_token) WHERE player_token IS NOT NULL;

-- ── Seed opcional — encuesta demo para /encuesta ─────────────────────────────
-- Se puede eliminar en prod si no se quiere sembrar nada.
INSERT INTO encuestas (slug, title, description, questions, is_active)
VALUES (
  'satisfaccion',
  'Contanos cómo la venís pasando',
  'Nos ayudás en 1 minuto — todas las respuestas son anónimas y opcionales.',
  $json$
  [
    { "id": "q1", "type": "rating", "label": "¿Cómo calificarías tu experiencia general?", "required": true },
    { "id": "q2", "type": "multiple", "label": "¿Qué juegos jugás más?", "options": ["Slots", "Ruleta", "Blackjack", "Poker", "Deportes", "Otros"], "required": false },
    { "id": "q3", "type": "select", "label": "¿Cada cuánto solés jugar?", "options": ["Todos los días", "Varias veces por semana", "Una vez por semana", "Menos seguido"], "required": false },
    { "id": "q4", "type": "rating", "label": "¿Qué tan probable es que nos recomiendes? (0 = nada, 10 = mucho)", "required": true },
    { "id": "q5", "type": "text", "label": "¿Qué podríamos mejorar?", "required": false }
  ]
  $json$::jsonb,
  true
)
ON CONFLICT (slug) DO NOTHING;
