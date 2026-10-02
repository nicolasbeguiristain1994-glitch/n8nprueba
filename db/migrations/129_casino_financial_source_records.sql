-- Reconciliation evidence: original precision and bonuses excluded by cash importers.
-- Does not change customer totals, segmentation or operational cash transactions.
CREATE TABLE IF NOT EXISTS casino_financial_source_records (
  platform text NOT NULL CHECK (platform IN ('zeus','bet30','ganamos','argenbet')),
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bono','importe_original')),
  transaction_id bigint REFERENCES casino_transactions(id),
  agente text NOT NULL,
  username text NOT NULL,
  monto numeric(28,10) NOT NULL CHECK (monto >= 0),
  fecha date NOT NULL,
  fecha_hora_utc timestamptz,
  source_sha256 text NOT NULL CHECK (length(source_sha256)=64),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform,source_id),
  CHECK ((kind='importe_original') = (transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS casino_financial_original_transaction
  ON casino_financial_source_records(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS casino_financial_source_scope
  ON casino_financial_source_records(platform,agente,fecha);
ALTER TABLE casino_financial_source_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON casino_financial_source_records FROM PUBLIC;
