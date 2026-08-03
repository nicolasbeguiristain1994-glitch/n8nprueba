-- 090_sending_reports: tabla de reportes diarios de envío WA
CREATE TABLE IF NOT EXISTS sending_reports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  oficina          TEXT        NOT NULL,
  linea            INTEGER     NOT NULL,
  base_datos       TEXT        NOT NULL,
  mensaje          TEXT        NOT NULL,
  segmentacion     TEXT,
  enviados         INTEGER     NOT NULL CHECK (enviados >= 0),
  respuestas       INTEGER     CHECK (respuestas >= 0),
  cargas           INTEGER     CHECK (cargas >= 0),
  fecha            DATE        NOT NULL DEFAULT CURRENT_DATE,
  operador_id      TEXT        NOT NULL,
  operador_nombre  TEXT        NOT NULL,
  observaciones    TEXT,
  estado           TEXT        NOT NULL DEFAULT 'pendiente'
                               CHECK (estado IN ('pendiente', 'completo')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sr_operador ON sending_reports(operador_id);
CREATE INDEX IF NOT EXISTS idx_sr_fecha    ON sending_reports(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_sr_oficina  ON sending_reports(oficina);
CREATE INDEX IF NOT EXISTS idx_sr_estado   ON sending_reports(estado);
