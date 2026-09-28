'use strict'

// Shared by contact imports and the daily CLI. No database connection is opened here.
const AGENTS = ['bigwin','ofizeus','betcoin','royal','farabet','zeus','zeusroyal','btcuno','btcdos','imperio','adminroyal','adminfara','adminbtc','adminzeus','admbigwin','adminbigwin','adminimperio','lasvegas','royalauto','horus','hades','generalfranqui','peaky']

function amountSQL(value) {
  return `CASE WHEN ${value} IS NULL THEN NULL
    WHEN ${value} >= 3200000 THEN 'super_vip' WHEN ${value} >= 1500000 THEN 'vip_alto'
    WHEN ${value} >= 1000000 THEN 'vip_medio' WHEN ${value} >= 500000 THEN 'vip'
    WHEN ${value} >= 100000 THEN 'medio' ELSE 'bajo' END`
}
function activitySQL(first, last, count) {
  first = `(${first})`; last = `(${last})`; count = `(${count})`
  return `CASE WHEN ${last} IS NULL OR ${last} > CURRENT_DATE THEN NULL
    WHEN CURRENT_DATE - ${last} > 180 THEN 'perdido'
    WHEN CURRENT_DATE - ${last} > 60 THEN 'inactivo'
    WHEN CURRENT_DATE - ${last} > 30 THEN 'en_riesgo'
    WHEN ${first} IS NULL OR ${first} > ${last} THEN NULL
    WHEN CURRENT_DATE - ${first} BETWEEN 0 AND 30 THEN 'nuevo'
    WHEN ${count}::numeric / GREATEST((CURRENT_DATE - ${first})::numeric / 7, 1) >= 3 THEN 'frecuente'
    WHEN ${count}::numeric / GREATEST((CURRENT_DATE - ${first})::numeric / 7, 1) >= 1 THEN 'regular'
    ELSE 'ocasional' END`
}

/** Caller owns a transaction on a single connection; all snapshots disappear at commit/rollback. */
async function prepareSegmentation(client, { contactIds = null, importedOnly = false } = {}) {
  await client.query(`CREATE TEMP TABLE seg_scope ON COMMIT DROP AS
    SELECT id FROM contacts WHERE deleted_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1))`, [contactIds])
  await client.query('CREATE UNIQUE INDEX ON seg_scope(id)')
  await client.query('ANALYZE seg_scope')
  await client.query(`CREATE TEMP TABLE seg_account_links ON COMMIT DROP AS
    SELECT l.* FROM casino_contact_account_links l JOIN seg_scope s ON s.id=l.contact_id`)
  await client.query('CREATE INDEX ON seg_account_links(contact_id)')
  await client.query('CREATE INDEX ON seg_account_links(player_id)')
  await client.query(`CREATE TEMP TABLE seg_sources ON COMMIT DROP AS
    SELECT p.*, LEAST(p.fecha_primera, cp.fecha_primera) AS known_first,
      GREATEST(p.fecha_ultima, cp.fecha_ultima) AS known_last,
      GREATEST(p.cant_cargas, cp.cant_cargas) AS known_count,
      GREATEST(p.cant_retiros, cp.cant_retiros) AS known_withdrawals,
      GREATEST(p.total_cargas, cp.total_cargas) AS known_amount
    FROM casino_segmentation_players p
    LEFT JOIN casino_players cp ON cp.username_lower=p.username_lower
      AND cp.platform IS NOT DISTINCT FROM p.platform
    WHERE lower(trim(p.agente)) = ANY($1::text[])
      AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM seg_account_links l WHERE l.player_id=p.id))`, [AGENTS, contactIds])
  await client.query('CREATE UNIQUE INDEX ON seg_sources(id)')
  await client.query(`DELETE FROM seg_account_links l WHERE NOT EXISTS (SELECT 1 FROM seg_sources p WHERE p.id=l.player_id)`)
  if (importedOnly) {
    // Restrict contacts, but retain ALL accounts of each affected person.
    await client.query(`DELETE FROM seg_scope s WHERE NOT EXISTS (
      SELECT 1 FROM seg_account_links l JOIN seg_sources p ON p.id=l.player_id
      WHERE l.contact_id=s.id AND p.id=md5('excel:' || p.platform || ':' || p.username_lower)::uuid)`)
    await client.query('DELETE FROM seg_account_links l WHERE NOT EXISTS (SELECT 1 FROM seg_scope s WHERE s.id=l.contact_id)')
  }
  // Autovacuum cannot analyze session-local tables. Without these statistics,
  // production chose an index/merge scan over millions of movements (>300s).
  await client.query('ANALYZE seg_sources')
  await client.query('ANALYZE seg_account_links')
  await client.query(`CREATE TEMP TABLE seg_transactions ON COMMIT DROP AS
    SELECT p.id AS player_id, ct.fecha, ct.tipo, ct.monto
    FROM seg_sources p JOIN casino_transactions ct ON lower(ct.username)=p.username_lower
      AND ct.platform IS NOT DISTINCT FROM p.platform
    WHERE ct.fecha <= CURRENT_DATE`)
  await client.query('CREATE INDEX ON seg_transactions(player_id)')
  await client.query('ANALYZE seg_transactions')
  await client.query(`CREATE TEMP TABLE seg_players ON COMMIT DROP AS
    WITH tx AS (
      SELECT player_id, SUM(monto) FILTER (WHERE tipo='carga') AS amount,
        COUNT(*) FILTER (WHERE tipo='carga')::int AS deposits,
        COUNT(*) FILTER (WHERE tipo='retiro')::int AS withdrawals,
        MIN(fecha) FILTER (WHERE tipo='carga') AS first_date,
        MAX(fecha) FILTER (WHERE tipo='carga') AS last_date
      FROM seg_transactions GROUP BY player_id
    )
    SELECT p.id, p.username_lower, p.platform, p.agente,
      CASE WHEN tx.deposits > 0 THEN tx.amount ELSE p.total_cargas END AS total_cargas,
      GREATEST(p.known_count, tx.deposits, 0) AS cant_cargas,
      GREATEST(p.known_withdrawals, tx.withdrawals, 0) AS cant_retiros,
      LEAST(p.known_first, tx.first_date) AS fecha_primera,
      GREATEST(p.known_last, tx.last_date) AS fecha_ultima,
      COALESCE(tx.deposits, 0) = 0 AS estimated,
      COALESCE(tx.deposits > 0 AND tx.amount < p.known_amount, false) AS partial_history,
      p.seg_actividad AS stored_activity
    FROM seg_sources p LEFT JOIN tx ON tx.player_id=p.id`)
  await client.query('CREATE UNIQUE INDEX ON seg_players(id)')
  await client.query('ANALYZE seg_players')
  // The numerator and its months always come from the same dataset. For historical
  // accounts without deposits, use their whole known calendar span, marked estimated.
  await client.query(`CREATE TEMP TABLE seg_months ON COMMIT DROP AS
    SELECT DISTINCT player_id, date_trunc('month',fecha)::date AS month
    FROM seg_transactions WHERE tipo='carga'
    UNION
    SELECT p.id, m::date FROM seg_players p
    CROSS JOIN LATERAL generate_series(date_trunc('month',p.fecha_primera),
      date_trunc('month',LEAST(p.fecha_ultima,CURRENT_DATE)),INTERVAL '1 month') m
    WHERE p.estimated AND p.fecha_primera IS NOT NULL AND p.fecha_ultima IS NOT NULL`)
  await client.query('CREATE INDEX ON seg_months(player_id)')
  await client.query('ANALYZE seg_months')
  await client.query(`CREATE TEMP TABLE seg_contact_profile ON COMMIT DROP AS
    WITH totals AS (
      SELECT l.contact_id, SUM(p.total_cargas) AS amount,
        MIN(p.fecha_primera) AS first_date, MAX(p.fecha_ultima) AS last_date,
        SUM(p.cant_cargas)::int AS deposits, SUM(p.cant_retiros)::int AS withdrawals,
        BOOL_OR(p.estimated) AS estimated, BOOL_OR(p.partial_history) AS partial_history,
        BOOL_AND(COALESCE(p.total_cargas=0,false) OR EXISTS (SELECT 1 FROM seg_months m WHERE m.player_id=p.id)) AS has_periods
      FROM seg_account_links l JOIN seg_players p ON p.id=l.player_id GROUP BY l.contact_id
    ), months AS (
      SELECT l.contact_id, COUNT(DISTINCT m.month) AS n
      FROM seg_account_links l JOIN seg_months m ON m.player_id=l.player_id GROUP BY l.contact_id
    ), metrics AS (
      SELECT t.*, CASE WHEN t.has_periods THEN t.amount / NULLIF(m.n,0) END AS monthly_average
      FROM totals t LEFT JOIN months m ON m.contact_id=t.contact_id
    )
    SELECT *, ${amountSQL('monthly_average')} AS segment,
      ${activitySQL('first_date', 'last_date', 'deposits')} AS activity
    FROM metrics`)
  await client.query('CREATE UNIQUE INDEX ON seg_contact_profile(contact_id)')
  await client.query('ANALYZE seg_contact_profile')
  return (await client.query(`SELECT COUNT(*)::int AS linked,
    COUNT(*) FILTER (WHERE c.segment::text IS DISTINCT FROM p.segment)::int AS changed_levels,
    COUNT(*) FILTER (WHERE p.estimated)::int AS estimated_levels,
    COUNT(*) FILTER (WHERE p.partial_history)::int AS partial_histories,
    COUNT(*) FILTER (WHERE p.activity IS NULL)::int AS unknown_activity
    FROM seg_contact_profile p JOIN contacts c ON c.id=p.contact_id`)).rows[0]
}

async function applySegmentation(client, { skipActivity = false, updatePlayers = true } = {}) {
  if (skipActivity) await client.query(`UPDATE seg_contact_profile p SET activity=(
    SELECT replace(t.tag,'casino:actividad:','') FROM contact_tags t
    WHERE t.contact_id=p.contact_id AND t.tag LIKE 'casino:actividad:%'
    ORDER BY t.added_at DESC,t.tag LIMIT 1)`)

  if (updatePlayers) await client.query(`WITH metrics AS (
      SELECT p.*, p.total_cargas / NULLIF((SELECT COUNT(*) FROM seg_months m WHERE m.player_id=p.id),0) AS avg
      FROM seg_players p
    ) UPDATE casino_players cp SET seg_monto=${amountSQL('p.avg')},
      ${skipActivity ? '' : `seg_actividad=${activitySQL('p.fecha_primera','p.fecha_ultima','p.cant_cargas')},`}
      dias_desde_ultimo=CURRENT_DATE-p.fecha_ultima,
      freq_semanal=ROUND(p.cant_cargas::numeric/GREATEST((CURRENT_DATE-p.fecha_primera)::numeric/7,1),2),
      updated_at=NOW()
    FROM metrics p WHERE cp.username_lower=p.username_lower AND cp.platform IS NOT DISTINCT FROM p.platform`)
  await client.query(`UPDATE contacts c SET segment=p.segment::contact_segment,
    total_deposits=p.deposits,total_withdrawals=p.withdrawals,
    last_deposit_at=p.last_date::timestamptz,updated_at=NOW()
    FROM seg_contact_profile p WHERE c.id=p.contact_id`)
  // Remove unsupported derived levels and all exclusive tag families in the same transaction.
  await client.query(`UPDATE contacts c SET
      segment=CASE WHEN c.segment::text IN ('bajo','medio','vip','vip_medio','vip_alto','super_vip') THEN NULL ELSE c.segment END,
      last_deposit_at=NULL,total_deposits=NULL,total_withdrawals=NULL,updated_at=NOW()
    FROM seg_scope s WHERE c.id=s.id
      AND (c.segment::text IN ('bajo','medio','vip','vip_medio','vip_alto','super_vip')
        OR EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id=c.id AND t.tag LIKE 'casino:%'))
      AND NOT EXISTS (SELECT 1 FROM seg_contact_profile p WHERE p.contact_id=c.id)`)
  await client.query(`DELETE FROM contact_tags t USING seg_scope s WHERE t.contact_id=s.id
    AND (t.tag LIKE 'casino:monto:%' OR t.tag LIKE 'casino:valor_riesgo:%' ${skipActivity ? '' : `OR t.tag LIKE 'casino:actividad:%' OR t.tag LIKE 'casino:antiguedad:%'`})`)
  await client.query(`INSERT INTO contact_tags(id,contact_id,tag,added_by,added_at)
    SELECT gen_random_uuid(),contact_id,unnest(array_remove(ARRAY[
      'casino:monto:' || segment,
      CASE WHEN activity IN ('perdido','inactivo','en_riesgo') THEN
        CASE WHEN segment IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
          WHEN segment='medio' THEN 'casino:valor_riesgo:medio'
          WHEN segment='bajo' THEN 'casino:valor_riesgo:bajo' END END
      ${skipActivity ? '' : `, 'casino:actividad:' || activity,
      CASE WHEN first_date IS NULL OR first_date>CURRENT_DATE THEN NULL
        WHEN CURRENT_DATE-first_date<30 THEN 'casino:antiguedad:nuevo'
        WHEN CURRENT_DATE-first_date<90 THEN 'casino:antiguedad:reciente'
        WHEN CURRENT_DATE-first_date<150 THEN 'casino:antiguedad:establecido'
        WHEN CURRENT_DATE-first_date<270 THEN 'casino:antiguedad:veterano'
        ELSE 'casino:antiguedad:leal' END`}
    ],NULL)), 'segmentar-script',NOW() FROM seg_contact_profile
    ON CONFLICT(contact_id,tag) DO NOTHING`)
  await client.query(`UPDATE contacts c SET casino_accounts=(
      SELECT jsonb_agg(DISTINCT a) FROM jsonb_array_elements(c.casino_accounts || p.accounts) a),
      platforms=ARRAY(SELECT DISTINCT unnest(COALESCE(c.platforms,'{}') || p.platforms)),updated_at=NOW()
    FROM (SELECT l.contact_id, jsonb_agg(jsonb_build_object('username',l.username_lower,'platform',l.platform,'panel',p.agente)) accounts,
        array_agg(DISTINCT l.platform) AS platforms
      FROM seg_account_links l JOIN seg_players p ON p.id=l.player_id
      WHERE l.platform IS NOT NULL GROUP BY l.contact_id) p
    WHERE c.id=p.contact_id`)
}

module.exports = { AGENTS, amountSQL, activitySQL, prepareSegmentation, applySegmentation }
