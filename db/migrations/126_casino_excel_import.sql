-- Monetary values remain PESOS, with cents preserved. Never multiply legacy data.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
ALTER TABLE casino_transactions ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE casino_transactions ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE casino_transactions ADD COLUMN IF NOT EXISTS source_file text;
ALTER TABLE casino_transactions ADD COLUMN IF NOT EXISTS source_row integer;
ALTER TABLE casino_transactions ALTER COLUMN monto TYPE numeric(20,2);
DROP INDEX IF EXISTS idx_casino_transactions_id_rec;
DROP INDEX IF EXISTS idx_casino_transactions_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_platform_id_rec
  ON casino_transactions(platform,id_rec) WHERE id_rec IS NOT NULL AND platform IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_legacy_id_rec
  ON casino_transactions(id_rec) WHERE id_rec IS NOT NULL AND platform IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_legacy_dedup
  ON casino_transactions(fecha,username,tipo,monto,agente) WHERE id_rec IS NULL AND platform IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_platform_dedup
  ON casino_transactions(platform,fecha,lower(username),tipo,monto,agente) WHERE id_rec IS NULL AND platform IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_source
  ON casino_transactions(platform, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_casino_transactions_import_username
  ON casino_transactions(lower(username), platform) WHERE source_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS casino_excel_imports (
  sha256 text PRIMARY KEY, source_file text NOT NULL, platform text NOT NULL,
  agente text NOT NULL, month text NOT NULL, coverage text NOT NULL,
  detail_rows integer NOT NULL, excluded_rows integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE casino_excel_imports ENABLE ROW LEVEL SECURITY;

-- Keep legacy casino_players and its global username upserts compatible.
-- Imported accounts have independent identities by platform; do not merge namesakes.
CREATE OR REPLACE VIEW casino_segmentation_players WITH (security_invoker = true) AS
WITH imported AS (
  SELECT md5('excel:' || platform || ':' || lower(username))::uuid AS id,
    lower(username)::varchar(100) AS username_lower, platform,
    (array_agg(agente ORDER BY fecha_hora_utc DESC, id DESC))[1] AS agente,
    coalesce(sum(monto) FILTER (WHERE tipo='carga'),0) AS total_cargas,
    coalesce(sum(monto) FILTER (WHERE tipo='retiro'),0) AS total_retiros,
    count(*) FILTER (WHERE tipo='carga')::integer AS cant_cargas,
    count(*) FILTER (WHERE tipo='retiro')::integer AS cant_retiros,
    min(fecha) FILTER (WHERE tipo='carga') AS fecha_primera,
    max(fecha) FILTER (WHERE tipo='carga') AS fecha_ultima,
    count(DISTINCT date_trunc('month',fecha)) FILTER (WHERE tipo='carga') AS meses_activos
  FROM casino_transactions WHERE source_id IS NOT NULL
  GROUP BY platform,lower(username)
), scored AS (
  SELECT *, total_cargas/greatest(meses_activos,1) AS promedio,
    cant_cargas/greatest((current_date-fecha_primera)::numeric/7,1) AS frecuencia
  FROM imported
)
SELECT id,username_lower,platform,agente,total_cargas,total_retiros,cant_cargas,cant_retiros,
  fecha_primera,fecha_ultima,
  CASE WHEN promedio>=3200000 THEN 'super_vip' WHEN promedio>=1500000 THEN 'vip_alto'
    WHEN promedio>=1000000 THEN 'vip_medio' WHEN promedio>=500000 THEN 'vip'
    WHEN promedio>=100000 THEN 'medio' ELSE 'bajo' END AS seg_monto,
  CASE WHEN fecha_ultima IS NULL OR current_date-fecha_ultima>180 THEN 'perdido'
    WHEN current_date-fecha_ultima>60 THEN 'inactivo' WHEN current_date-fecha_ultima>30 THEN 'en_riesgo'
    WHEN current_date-fecha_primera<=30 THEN 'nuevo' WHEN frecuencia>=3 THEN 'frecuente'
    WHEN frecuencia>=1 THEN 'regular' ELSE 'ocasional' END AS seg_actividad
FROM scored
UNION ALL
SELECT cp.id,cp.username_lower,cp.platform,cp.agente,cp.total_cargas,cp.total_retiros,
  cp.cant_cargas,cp.cant_retiros,cp.fecha_primera,cp.fecha_ultima,cp.seg_monto,cp.seg_actividad
FROM casino_players cp
WHERE NOT EXISTS (SELECT 1 FROM imported i WHERE i.username_lower=cp.username_lower
  AND (i.platform=cp.platform OR (cp.platform IS NULL AND lower(trim(cp.agente))=i.agente)));

-- Explicit account links take precedence; name-only matching is permitted only
-- for globally unambiguous usernames. Existing marketing consent is never changed.
CREATE OR REPLACE VIEW casino_contact_account_links WITH (security_invoker = true) AS
WITH players AS MATERIALIZED (SELECT *, count(*) OVER (PARTITION BY username_lower) AS name_count,
 CASE lower(trim(agente))
 WHEN 'adminroyal' THEN 'royal' WHEN 'adminfara' THEN 'farabet' WHEN 'adminbtc' THEN 'betcoin'
 WHEN 'adminzeus' THEN 'ofizeus' WHEN 'admbigwin' THEN 'bigwin' WHEN 'adminbigwin' THEN 'bigwin'
 WHEN 'adminimperio' THEN 'bigwin' WHEN 'imperio' THEN 'bigwin'
 WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet' WHEN 'zeus' THEN 'ofizeus'
 WHEN 'zeusroyal' THEN 'royal' ELSE lower(trim(agente)) END AS panel FROM casino_segmentation_players),
unique_panels AS (
 SELECT username_lower,panel,min(id::text)::uuid AS player_id FROM (
   SELECT username_lower,panel,id FROM players
   UNION SELECT username_lower,lower(trim(agente)),id FROM players
 ) names GROUP BY username_lower,panel HAVING count(DISTINCT id)=1
),
tokens AS (
 SELECT c.id, lower(tok) AS username FROM contacts c
 CROSS JOIN LATERAL regexp_split_to_table(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''),'[^a-zA-Z0-9_]+') tok
 WHERE c.deleted_at IS NULL AND length(tok)>=4
), explicit AS MATERIALIZED (
 SELECT c.id, lower(trim(a->>'username')) AS username, a->>'platform' AS platform, lower(a->>'panel') AS panel
 FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
 WHERE c.deleted_at IS NULL
)
SELECT e.id AS contact_id,p.id AS player_id,p.username_lower,p.platform
FROM explicit e JOIN players p ON p.username_lower=e.username AND p.platform=e.platform
UNION
SELECT e.id,p.id,p.username_lower,p.platform FROM explicit e
JOIN unique_panels up ON up.username_lower=e.username AND up.panel=e.panel
JOIN players p ON p.id=up.player_id WHERE e.platform IS NULL
UNION
SELECT e.id,p.id,p.username_lower,p.platform FROM explicit e
JOIN players p ON p.username_lower=e.username AND p.name_count=1
WHERE e.platform IS NULL AND e.panel IS NULL
UNION
SELECT t.id,p.id,p.username_lower,p.platform
FROM tokens t JOIN players p ON p.username_lower=t.username AND p.name_count=1
LEFT JOIN explicit e ON e.id=t.id AND e.username=t.username
WHERE e.id IS NULL
 AND t.username NOT IN ('farabet','betcoin','bigwin','royal','ofizeus','zeus','zeusroyal','btcuno','btcdos','adminbet','surmar','lemon','apolo','horus','peaky','soporte','reclamos','linea','admin','mismo','usuario','titular','carga','mucho');

CREATE OR REPLACE FUNCTION preserve_explicit_casino_platforms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.platforms := ARRAY(SELECT DISTINCT p FROM (
   SELECT unnest(coalesce(NEW.platforms,'{}')) AS p
   UNION SELECT a->>'platform' FROM jsonb_array_elements(NEW.casino_accounts) a
   WHERE a->>'platform' IN ('zeus','bet30','ganamos','argenbet')
 ) all_platforms WHERE p IS NOT NULL ORDER BY p);
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_contact_platforms_imported ON contacts;
CREATE TRIGGER trg_contact_platforms_imported BEFORE INSERT OR UPDATE OF first_name,last_name,casino_accounts,platforms
 ON contacts FOR EACH ROW EXECUTE FUNCTION preserve_explicit_casino_platforms();
COMMIT;
