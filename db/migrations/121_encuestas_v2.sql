-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 121 — Encuestas fase 2
--
-- 1) `encuestas`: columnas `scope` + `agent_id` (preparación para scoping por
--    agente en la próxima fase — hoy sólo se usa 'global', pero el schema
--    queda listo para no tener que romper la tabla más adelante).
--
-- 2) `encuesta_respuestas`: columnas `username` (obligatorio) y `email`
--    (opcional). Índices por username, email, campaign (campaign ya existe
--    desde 120).
--
-- 3) Seed / upsert de la encuesta "Satisfacción y Preferencias de Jugadores"
--    con las 9 preguntas oficiales del casino.
--
-- Nota: `ip_hash` y `user_agent` YA existen en la tabla desde la migración
-- 120; no se agregan de nuevo.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── encuestas: scope + agent_id ─────────────────────────────────────────────
ALTER TABLE encuestas ADD COLUMN IF NOT EXISTS scope    TEXT NOT NULL DEFAULT 'global';
ALTER TABLE encuestas ADD COLUMN IF NOT EXISTS agent_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'encuestas_scope_check'
  ) THEN
    ALTER TABLE encuestas
      ADD CONSTRAINT encuestas_scope_check CHECK (scope IN ('global', 'per_agent'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'encuestas_scope_agent_consistency'
  ) THEN
    -- global: agent_id debe ser NULL. per_agent: agent_id obligatorio.
    ALTER TABLE encuestas
      ADD CONSTRAINT encuestas_scope_agent_consistency CHECK (
        (scope = 'global'    AND agent_id IS NULL) OR
        (scope = 'per_agent' AND agent_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_encuestas_agent ON encuestas (agent_id) WHERE agent_id IS NOT NULL;

-- ── encuesta_respuestas: username + email ───────────────────────────────────
ALTER TABLE encuesta_respuestas ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE encuesta_respuestas ADD COLUMN IF NOT EXISTS email    TEXT;

-- Backfill: filas anteriores a esta migración toman un placeholder derivado
-- del id para poder marcar la columna como NOT NULL sin perder historia.
UPDATE encuesta_respuestas
   SET username = 'legacy_' || substring(id::text FROM 1 FOR 8)
 WHERE username IS NULL;

ALTER TABLE encuesta_respuestas ALTER COLUMN username SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'encuesta_resp_username_len'
  ) THEN
    ALTER TABLE encuesta_respuestas
      ADD CONSTRAINT encuesta_resp_username_len
      CHECK (char_length(username) BETWEEN 3 AND 60);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'encuesta_resp_email_len'
  ) THEN
    ALTER TABLE encuesta_respuestas
      ADD CONSTRAINT encuesta_resp_email_len
      CHECK (email IS NULL OR char_length(email) BETWEEN 5 AND 254);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_encresp_username ON encuesta_respuestas (username);
CREATE INDEX IF NOT EXISTS idx_encresp_email    ON encuesta_respuestas (email) WHERE email IS NOT NULL;

-- ── Seed: encuesta oficial ──────────────────────────────────────────────────
INSERT INTO encuestas (slug, title, description, questions, is_active, scope)
VALUES (
  'satisfaccion',
  'Satisfacción y Preferencias de Jugadores',
  'Nos das una mano en 2 minutos. Tus respuestas nos ayudan a mejorar la plataforma y los bonos.',
  $json$
  [
    {
      "id": "edad",
      "type": "select",
      "label": "¿Qué edad tenés?",
      "options": ["18-24", "25-34", "35-44", "45-54", "55+"],
      "required": true
    },
    {
      "id": "juegos",
      "type": "multiple",
      "label": "¿Cuáles son tus juegos favoritos?",
      "options": ["Slots", "Ruleta", "Blackjack", "Poker", "Bingo", "Baccarat", "Crash / Aviator", "Live Casino", "Deportes", "Otros"],
      "required": true,
      "allowOther": true,
      "otherOption": "Otros",
      "otherLabel": "¿Cuáles? (opcional)"
    },
    {
      "id": "bonos",
      "type": "multiple",
      "label": "¿Qué tipo de bonos o promociones te gustan más?",
      "options": ["Bono de bienvenida", "Giros gratis", "Cashback / Devolución", "Recargas", "Torneos", "Promos VIP", "Otros"],
      "required": false,
      "allowOther": true,
      "otherOption": "Otros",
      "otherLabel": "Contanos cuál"
    },
    {
      "id": "facilidad",
      "type": "rating",
      "label": "Del 1 al 10, ¿qué tan fácil te resulta navegar y jugar en la plataforma?",
      "min": 1,
      "max": 10,
      "required": true,
      "helpText": "1 = muy difícil, 10 = súper fácil"
    },
    {
      "id": "cashflow",
      "type": "rating",
      "label": "¿Qué tan satisfecho estás con los tiempos de depósito y retiro?",
      "min": 1,
      "max": 10,
      "required": true,
      "helpText": "1 = muy insatisfecho, 10 = muy satisfecho"
    },
    {
      "id": "soporte",
      "type": "rating",
      "label": "¿Qué tan satisfecho estás con la atención al cliente y el soporte?",
      "min": 1,
      "max": 10,
      "required": true,
      "helpText": "1 = muy insatisfecho, 10 = muy satisfecho"
    },
    {
      "id": "soporte_comentario",
      "type": "text",
      "label": "¿Qué mejorarías del soporte?",
      "required": false,
      "helpText": "Opcional — dejalo vacío si no tenés comentarios."
    },
    {
      "id": "motivacion",
      "type": "multiple",
      "label": "¿Qué te haría jugar más frecuentemente en el casino?",
      "options": ["Mejores bonos", "Retiros más rápidos", "Más variedad de juegos", "Mejor soporte", "Torneos y premios", "App móvil", "Otro"],
      "required": true,
      "allowOther": true,
      "otherOption": "Otro",
      "otherLabel": "Contanos qué"
    },
    {
      "id": "nps",
      "type": "rating",
      "label": "Del 0 al 10, ¿qué tan probable es que nos recomiendes a un amigo?",
      "min": 0,
      "max": 10,
      "required": true,
      "helpText": "0 = nada probable, 10 = altamente probable"
    },
    {
      "id": "mejoras",
      "type": "text",
      "label": "¿Qué mejorarías?",
      "required": false,
      "helpText": "Cualquier idea, comentario o queja."
    }
  ]
  $json$::jsonb,
  true,
  'global'
)
ON CONFLICT (slug) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  questions   = EXCLUDED.questions,
  is_active   = true,
  scope       = 'global',
  agent_id    = NULL,
  updated_at  = NOW();
