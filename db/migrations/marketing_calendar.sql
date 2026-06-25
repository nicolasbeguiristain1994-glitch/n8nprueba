-- Renombrar este archivo con el número de migración correspondiente
-- Ej: 072_marketing_calendar.sql

CREATE TABLE IF NOT EXISTS marketing_calendar (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE        NOT NULL,
  hour        SMALLINT    CHECK (hour IS NULL OR (hour >= 0 AND hour <= 23)),
  title       TEXT        NOT NULL,
  consigna    TEXT,
  image_url   TEXT,
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_calendar_date
  ON marketing_calendar(date);

COMMENT ON TABLE marketing_calendar IS
  'Contenido de marketing por día y hora: imágenes + consignas para difusión';
COMMENT ON COLUMN marketing_calendar.hour IS
  '0-23 para hora específica, NULL para todo el día';
