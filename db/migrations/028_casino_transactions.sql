-- 028_casino_transactions.sql
-- Transacciones individuales del casino (depósitos y retiros por jugador).
-- Permite reportes financieros filtrados por rango de fechas exactas,
-- en lugar de depender de los totales acumulados en casino_players.

CREATE TABLE IF NOT EXISTS casino_transactions (
    id           BIGSERIAL PRIMARY KEY,
    id_rec       BIGINT,                          -- ID de Zeus (IDREC); NULL si la API no lo devuelve
    fecha        DATE        NOT NULL,
    agente       VARCHAR(50) NOT NULL,
    username     VARCHAR(100) NOT NULL,
    tipo         VARCHAR(10) NOT NULL CHECK (tipo IN ('carga','retiro')),
    monto        BIGINT      NOT NULL,            -- valor absoluto en pesos
    raw_detalles TEXT,
    synced_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Deduplicación: si Zeus devuelve id_rec, se usa como clave única.
-- Se crea condicional para que no falle si ya existe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_id_rec
    ON casino_transactions (id_rec)
    WHERE id_rec IS NOT NULL;

-- Fallback de deduplicación cuando no hay id_rec:
-- (fecha, username, tipo, monto, agente) debería ser suficientemente único.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_dedup
    ON casino_transactions (fecha, username, tipo, monto, agente)
    WHERE id_rec IS NULL;

-- Índices para los filtros más comunes del dashboard
CREATE INDEX IF NOT EXISTS idx_casino_transactions_fecha
    ON casino_transactions (fecha);

CREATE INDEX IF NOT EXISTS idx_casino_transactions_agente_fecha
    ON casino_transactions (agente, fecha);

CREATE INDEX IF NOT EXISTS idx_casino_transactions_username
    ON casino_transactions (username);

COMMENT ON TABLE casino_transactions IS
    'Transacciones individuales de depósito/retiro del casino Zeus. '
    'Permite filtrar reportes financieros por rango de fechas exactas. '
    'Poblada por sync-casino-players-live.js.';
