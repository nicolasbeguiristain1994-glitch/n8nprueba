BEGIN;

-- ── Montos de depósito para scoring de valor monetario real ───────────────────
--
-- La v1 del módulo de priorización usa contacts.segment como proxy de valor.
-- Estas columnas permiten calcular un value_score más preciso cuando el dato
-- esté disponible (importación CSV o integración directa con el casino).
--
-- Mientras sean NULL, el servicio hace fallback a segment.
-- Calibrar los umbrales en config.ts una vez que estén poblados.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS total_deposit_amount  NUMERIC(14,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_deposit_amount   NUMERIC(14,2) DEFAULT NULL;

COMMENT ON COLUMN contacts.total_deposit_amount IS
  'Monto total acumulado de depósitos (moneda base del casino). NULL = no disponible.';
COMMENT ON COLUMN contacts.last_deposit_amount IS
  'Monto del último depósito registrado. NULL = no disponible.';

CREATE INDEX IF NOT EXISTS idx_contacts_deposit_amount
  ON contacts (total_deposit_amount DESC NULLS LAST)
  WHERE status IN ('active', 'inactive') AND deleted_at IS NULL;

COMMIT;
