import type { InactivityRange } from './inactivity-range'

/** Same account identity rules as migration 126; only relevant movements and
 * scoped contacts participate in the expensive joins. Ambiguity remains global. */
export function contactMovementQuery(audience: { sql: string; params: unknown[] }, range: InactivityRange, platform: string) {
  const params = [...audience.params]
  const bind = (value: unknown) => { params.push(value); return `$${params.length}` }
  const period = range.mode === 'period'
  const date = period ? 't.fecha' : 'last_movement'
  const bounds = [`${date} <= CURRENT_DATE`]
  if (range.min !== '') bounds.push(`${date} < CURRENT_DATE - ${bind(Number(range.min))}::int`)
  if (range.max !== '') bounds.push(`${date} >= CURRENT_DATE - ${bind(Number(range.max))}::int`)
  const platformSql = platform ? `AND t.platform=${bind(platform)}::text` : ''
  return { params, sql: `WITH
    movement_accounts AS MATERIALIZED (
      SELECT t.platform,lower(t.username) username_lower,max(t.fecha) last_movement
      FROM casino_transactions t
      WHERE t.tipo IN ('carga','retiro') AND t.platform IN ('zeus','bet30','ganamos','argenbet')
        ${platformSql} AND ${period ? bounds.join(' AND ') : 'TRUE'}
      GROUP BY t.platform,lower(t.username)
    ), players AS MATERIALIZED (
      SELECT id,username_lower,platform,agente,
        count(*) OVER (PARTITION BY username_lower) name_count,
        CASE lower(trim(agente))
          WHEN 'adminroyal' THEN 'royal' WHEN 'adminfara' THEN 'farabet' WHEN 'adminbtc' THEN 'betcoin'
          WHEN 'adminzeus' THEN 'ofizeus' WHEN 'admbigwin' THEN 'bigwin' WHEN 'adminbigwin' THEN 'bigwin'
          WHEN 'adminimperio' THEN 'bigwin' WHEN 'imperio' THEN 'bigwin'
          WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet' WHEN 'zeus' THEN 'ofizeus'
          WHEN 'zeusroyal' THEN 'royal' ELSE lower(trim(agente)) END panel
      FROM casino_segmentation_players
    ), eligible_players AS MATERIALIZED (
      SELECT p.*,m.last_movement FROM players p JOIN movement_accounts m
        ON m.platform=p.platform AND m.username_lower=p.username_lower
    ), unique_panels AS MATERIALIZED (
      SELECT username_lower,panel,min(id::text)::uuid player_id FROM (
        SELECT username_lower,panel,id FROM players
        UNION SELECT username_lower,lower(trim(agente)),id FROM players
      ) names GROUP BY username_lower,panel HAVING count(DISTINCT id)=1
    ), scoped_contacts AS MATERIALIZED (
      SELECT contacts.id,first_name,last_name,casino_accounts FROM contacts WHERE ${audience.sql}
        AND contact_movement_names(first_name,last_name,casino_accounts) &&
          (SELECT coalesce(array_agg(DISTINCT username_lower::text),'{}') FROM eligible_players)
    ), explicit AS MATERIALIZED (
      SELECT c.id,lower(trim(a->>'username')) username,a->>'platform' platform,lower(a->>'panel') panel
      FROM scoped_contacts c CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
    ), tokens AS (
      SELECT c.id,lower(tok) username FROM scoped_contacts c
      CROSS JOIN LATERAL regexp_split_to_table(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''),'[^a-zA-Z0-9_]+') tok
      WHERE length(tok)>=4
    ), linked AS (
      SELECT e.id contact_id,p.last_movement FROM explicit e JOIN eligible_players p
        ON p.username_lower=e.username AND p.platform=e.platform
      UNION ALL
      SELECT e.id,p.last_movement FROM explicit e
        JOIN unique_panels up ON up.username_lower=e.username AND up.panel=e.panel
        JOIN eligible_players p ON p.id=up.player_id WHERE e.platform IS NULL
      UNION ALL
      SELECT e.id,p.last_movement FROM explicit e JOIN eligible_players p
        ON p.username_lower=e.username AND p.name_count=1 WHERE e.platform IS NULL AND e.panel IS NULL
      UNION ALL
      SELECT t.id,p.last_movement FROM tokens t JOIN eligible_players p
        ON p.username_lower=t.username AND p.name_count=1
        LEFT JOIN explicit e ON e.id=t.id AND e.username=t.username
      WHERE e.id IS NULL AND t.username NOT IN
        ('farabet','betcoin','bigwin','royal','ofizeus','zeus','zeusroyal','btcuno','btcdos','adminbet','surmar','lemon','apolo','horus','peaky','soporte','reclamos','linea','admin','mismo','usuario','titular','carga','mucho')
    ), movements AS (
      SELECT contact_id,max(last_movement) last_movement FROM linked GROUP BY contact_id
    ) SELECT contact_id,CURRENT_DATE-last_movement days_inactive FROM movements
      ${period ? '' : `WHERE ${bounds.join(' AND ')}`}` }
}
