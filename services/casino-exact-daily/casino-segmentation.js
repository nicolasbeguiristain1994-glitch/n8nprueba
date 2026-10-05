'use strict'

// Shared by contact imports and the daily CLI. No database connection is opened here.
const AGENTS = ['bigwin','ofizeus','betcoin','royal','farabet','zeus','zeusroyal','btcuno','btcdos','imperio','adminroyal','adminfara','adminbtc','adminzeus','admbigwin','adminbigwin','adminimperio','lasvegas','royalauto','horus','hades','generalfranqui','peaky']

function amountSQL(value) { return `casino_monthly_value_tier(${value})` }
function activitySQL(first, last, count) {
  return `casino_deposit_activity((${first})::date,(${last})::date,(${count})::int,CURRENT_DATE)`
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
    FROM seg_sources p JOIN casino_cash_movements ct ON ct.username_lower=p.username_lower
      AND ct.platform IS NOT DISTINCT FROM p.platform
    WHERE ct.fecha <= CURRENT_DATE`)
  await client.query('CREATE INDEX ON seg_transactions(player_id)')
  await client.query('ANALYZE seg_transactions')
  await client.query(`CREATE TEMP TABLE seg_players ON COMMIT DROP AS
    WITH tx AS (
      SELECT player_id, SUM(monto) FILTER (WHERE tipo='carga') AS amount,
        COUNT(*) FILTER (WHERE tipo='carga')::int AS deposits,
        COUNT(*) FILTER (WHERE tipo='bono')::int AS bonuses,
        COUNT(*) FILTER (WHERE tipo='retiro')::int AS withdrawals,
        MIN(fecha) FILTER (WHERE tipo='carga') AS first_date,
        MAX(fecha) FILTER (WHERE tipo='carga') AS last_date,
        SUM(monto) FILTER (WHERE tipo='carga' AND fecha>=CURRENT_DATE-29) AS amount_30d,
        SUM(monto) FILTER (WHERE tipo='carga' AND fecha>=CURRENT_DATE-89) AS amount_90d,
        COUNT(*) FILTER (WHERE tipo='carga' AND fecha>=CURRENT_DATE-29)::int AS deposits_30d,
        COUNT(*) FILTER (WHERE tipo='carga' AND fecha>=CURRENT_DATE-89)::int AS deposits_90d
      FROM seg_transactions GROUP BY player_id
    )
    SELECT p.id, p.username_lower, p.platform, p.agente,
      CASE WHEN tx.player_id IS NOT NULL THEN COALESCE(tx.amount,0) ELSE p.total_cargas END AS total_cargas,
      CASE WHEN tx.player_id IS NOT NULL THEN GREATEST(tx.deposits,p.known_count-tx.bonuses) ELSE COALESCE(p.known_count,0) END AS cant_cargas,
      CASE WHEN tx.player_id IS NOT NULL THEN tx.withdrawals ELSE COALESCE(p.known_withdrawals,0) END AS cant_retiros,
      CASE WHEN tx.player_id IS NOT NULL THEN CASE WHEN p.known_count>tx.deposits+tx.bonuses THEN LEAST(p.known_first,tx.first_date) ELSE tx.first_date END ELSE p.known_first END AS fecha_primera,
      CASE WHEN tx.player_id IS NOT NULL THEN tx.last_date ELSE p.known_last END AS fecha_ultima,
      tx.player_id IS NULL AS estimated,
      COALESCE(tx.player_id IS NOT NULL AND p.known_count > tx.deposits + tx.bonuses, false) AS partial_history,
      p.seg_actividad AS stored_activity,
      CASE WHEN tx.player_id IS NOT NULL THEN COALESCE(tx.amount_30d,0) END AS amount_30d,
      CASE WHEN tx.player_id IS NOT NULL THEN COALESCE(tx.amount_90d,0) END AS amount_90d,
      tx.deposits_30d,tx.deposits_90d
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
        CASE WHEN NOT BOOL_OR(p.estimated) THEN SUM(p.amount_30d) END AS amount_30d,
        CASE WHEN NOT BOOL_OR(p.estimated) THEN SUM(p.amount_90d) END AS amount_90d,
        CASE WHEN NOT BOOL_OR(p.estimated) THEN SUM(p.deposits_30d) END AS deposits_30d,
        CASE WHEN NOT BOOL_OR(p.estimated) THEN SUM(p.deposits_90d) END AS deposits_90d,
        BOOL_AND(COALESCE(p.total_cargas=0,false) OR EXISTS (SELECT 1 FROM seg_months m WHERE m.player_id=p.id)) AS has_periods
      FROM seg_account_links l JOIN seg_players p ON p.id=l.player_id GROUP BY l.contact_id
    ), months AS (
      SELECT l.contact_id, COUNT(DISTINCT m.month) AS n
      FROM seg_account_links l JOIN seg_months m ON m.player_id=l.player_id GROUP BY l.contact_id
    ), metrics AS (
      SELECT t.*, COALESCE(m.n,0)::int AS active_months, CASE WHEN t.has_periods THEN t.amount / NULLIF(m.n,0) END AS monthly_average
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

async function applySegmentation(client, { skipActivity = false, updatePlayers = true, preserveActivityPlatforms = [] } = {}) {
  await client.query(`CREATE TEMP TABLE seg_preserve_activity ON COMMIT DROP AS
    SELECT DISTINCT contact_id FROM seg_account_links WHERE platform=ANY($1::text[])`, [preserveActivityPlatforms])
  await client.query('CREATE UNIQUE INDEX ON seg_preserve_activity(contact_id)')
  await client.query('ANALYZE seg_preserve_activity')
  if (!skipActivity) await client.query(`UPDATE seg_contact_profile p SET activity=(
    SELECT replace(t.tag,'casino:actividad:','') FROM contact_tags t
    WHERE t.contact_id=p.contact_id AND t.tag LIKE 'casino:actividad:%'
    ORDER BY t.added_at DESC,t.tag LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM seg_preserve_activity a WHERE a.contact_id=p.contact_id)`)
  if (skipActivity) await client.query(`UPDATE seg_contact_profile p SET activity=(
    SELECT replace(t.tag,'casino:actividad:','') FROM contact_tags t
    WHERE t.contact_id=p.contact_id AND t.tag LIKE 'casino:actividad:%'
    ORDER BY t.added_at DESC,t.tag LIMIT 1)`)

  if (updatePlayers) await client.query(`WITH metrics AS (
      SELECT p.*, p.total_cargas / NULLIF((SELECT COUNT(*) FROM seg_months m WHERE m.player_id=p.id),0) AS avg
      FROM seg_players p
    ) UPDATE casino_players cp SET seg_monto=${amountSQL('p.avg')},
      ${skipActivity ? '' : `seg_actividad=CASE WHEN p.platform=ANY($1::text[]) THEN cp.seg_actividad ELSE ${activitySQL('p.fecha_primera','p.fecha_ultima','p.cant_cargas')} END,`}
      dias_desde_ultimo=CURRENT_DATE-p.fecha_ultima,
      freq_semanal=ROUND(p.cant_cargas::numeric/GREATEST((CURRENT_DATE-p.fecha_primera)::numeric/7,1),2),
      updated_at=NOW()
    FROM metrics p WHERE cp.username_lower=p.username_lower AND cp.platform IS NOT DISTINCT FROM p.platform`, skipActivity ? [] : [preserveActivityPlatforms])
  await client.query(`CREATE TEMP TABLE seg_sync_status ON COMMIT DROP AS
    SELECT platform,max(finished_at) last_sync_at FROM casino_sync_runs WHERE status='success' GROUP BY platform`)
  await client.query('CREATE UNIQUE INDEX ON seg_sync_status(platform)')
  await client.query(`UPDATE contacts c SET segment=CASE WHEN c.segment_is_manual THEN c.segment ELSE p.segment::contact_segment END,
    segmentation_profile=to_jsonb(p)-'contact_id'-'segment'-'activity'-'has_periods' || jsonb_build_object(
      'calculated_at',NOW(),'as_of',CURRENT_DATE,
      'accounts',(SELECT jsonb_agg(jsonb_build_object('platform',l.platform,'username',l.username_lower,
        'last_sync_at',(SELECT r.last_sync_at FROM seg_sync_status r WHERE r.platform=l.platform)))
        FROM seg_account_links l WHERE l.contact_id=p.contact_id)),
    total_deposits=p.deposits,total_withdrawals=p.withdrawals,
    last_deposit_at=p.last_date::timestamptz,updated_at=NOW()
    FROM seg_contact_profile p WHERE c.id=p.contact_id`)
  // Remove unsupported derived levels and all exclusive tag families in the same transaction.
  await client.query(`UPDATE contacts c SET
      segmentation_profile=NULL,
      segment=CASE WHEN NOT c.segment_is_manual AND c.segment::text IN ('bajo','medio','vip','vip_medio','vip_alto','super_vip') THEN NULL ELSE c.segment END,
      last_deposit_at=NULL,total_deposits=NULL,total_withdrawals=NULL,updated_at=NOW()
    FROM seg_scope s WHERE c.id=s.id
      AND (c.segmentation_profile IS NOT NULL OR c.segment::text IN ('bajo','medio','vip','vip_medio','vip_alto','super_vip')
        OR EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id=c.id AND t.tag LIKE 'casino:%'))
      AND NOT EXISTS (SELECT 1 FROM seg_contact_profile p WHERE p.contact_id=c.id)`)
  await client.query(`DELETE FROM contact_tags t USING seg_scope s WHERE t.contact_id=s.id
    AND (t.tag LIKE 'casino:monto:%' OR t.tag LIKE 'casino:valor_riesgo:%' ${skipActivity ? '' : `OR ((t.tag LIKE 'casino:actividad:%' OR t.tag LIKE 'casino:antiguedad:%') AND NOT EXISTS (SELECT 1 FROM seg_preserve_activity a WHERE a.contact_id=t.contact_id))`})`)
  await client.query(`INSERT INTO contact_tags(id,contact_id,tag,added_by,added_at)
    SELECT gen_random_uuid(),contact_id,unnest(array_remove(ARRAY[
      'casino:monto:' || segment,
      CASE WHEN activity IN ('perdido','inactivo','en_riesgo') THEN
        CASE WHEN segment IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
          WHEN segment='medio' THEN 'casino:valor_riesgo:medio'
          WHEN segment='bajo' THEN 'casino:valor_riesgo:bajo' END END
      ${skipActivity ? '' : `, CASE WHEN NOT EXISTS (SELECT 1 FROM seg_preserve_activity a WHERE a.contact_id=seg_contact_profile.contact_id) THEN 'casino:actividad:' || activity END,
      CASE WHEN EXISTS (SELECT 1 FROM seg_preserve_activity a WHERE a.contact_id=seg_contact_profile.contact_id) THEN NULL WHEN first_date IS NULL OR first_date>CURRENT_DATE THEN NULL
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

function activityPreservationPlatforms() {
  const platforms = (process.env.CASINO_SEGMENTATION_PRESERVE_ACTIVITY_PLATFORMS || '').split(',').map(v => v.trim()).filter(Boolean)
  if (platforms.some(p => !['zeus','bet30','ganamos','argenbet'].includes(p))) throw new Error('INVALID_ACTIVITY_PRESERVATION_PLATFORMS')
  return platforms
}

module.exports = { activityPreservationPlatforms, AGENTS, amountSQL, activitySQL, prepareSegmentation, applySegmentation }
