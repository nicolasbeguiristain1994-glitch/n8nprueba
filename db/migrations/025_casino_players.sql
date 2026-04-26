-- 025_casino_players.sql
-- Tabla de segmentación de jugadores de casino para auto-tagging en importación de contactos

CREATE TABLE IF NOT EXISTS casino_players (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(100) NOT NULL,
    username_lower  VARCHAR(100) GENERATED ALWAYS AS (LOWER(username)) STORED,
    agente          VARCHAR(50),
    user_id         INTEGER,
    total_cargas    BIGINT  DEFAULT 0,
    cant_cargas     INTEGER DEFAULT 0,
    total_retiros   BIGINT  DEFAULT 0,
    cant_retiros    INTEGER DEFAULT 0,
    freq_semanal    NUMERIC(6,2),
    dias_desde_ultimo INTEGER,
    fecha_primera   DATE,
    fecha_ultima    DATE,
    seg_monto       VARCHAR(20) CHECK (seg_monto IN ('bajo','medio','alto','vip')),
    seg_actividad   VARCHAR(20) CHECK (seg_actividad IN ('nuevo','frecuente','regular','ocasional','en_riesgo','inactivo')),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índice único en username_lower para búsquedas case-insensitive rápidas
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_players_username_lower
    ON casino_players (username_lower);

-- Índices para filtrar por segmento
CREATE INDEX IF NOT EXISTS idx_casino_players_seg_monto
    ON casino_players (seg_monto);

CREATE INDEX IF NOT EXISTS idx_casino_players_seg_actividad
    ON casino_players (seg_actividad);

CREATE INDEX IF NOT EXISTS idx_casino_players_agente
    ON casino_players (agente);

COMMENT ON TABLE casino_players IS
    'Jugadores del panel de casino con sus métricas y segmentos calculados. '
    'Se usa para auto-etiquetar contactos de WhatsApp al importarlos.';
