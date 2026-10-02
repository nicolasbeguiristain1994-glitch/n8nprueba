// Same four identity rules as casino_contact_account_links (migration 126),
// scoped to campaign recipients before expanding contact names/accounts. Keep
// all platforms for each candidate username so ambiguity cannot disappear when
// filtering campaigns. No cached balances or guessed platform assignments.
export const CAMPAIGN_CONTACT_ACCOUNTS_SQL = `
  WITH scoped_contacts AS MATERIALIZED (
    SELECT id,first_name,last_name,casino_accounts FROM contacts
    WHERE deleted_at IS NULL AND id IN (SELECT contact_id FROM recipients)
  ), explicit AS MATERIALIZED (
    SELECT c.id,lower(trim(a->>'username')) AS username,
      a->>'platform' AS platform,lower(a->>'panel') AS panel
    FROM scoped_contacts c CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
  ), tokens AS MATERIALIZED (
    SELECT c.id,lower(tok) AS username FROM scoped_contacts c
    CROSS JOIN LATERAL regexp_split_to_table(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''),'[^a-zA-Z0-9_]+') tok
    WHERE length(tok)>=4
  ), names AS (
    SELECT username FROM explicit UNION SELECT username FROM tokens
  ), players AS MATERIALIZED (
    SELECT p.id,p.username_lower,p.platform,p.agente,
      count(*) OVER (PARTITION BY p.username_lower) AS name_count,
      CASE lower(trim(p.agente))
        WHEN 'adminroyal' THEN 'royal' WHEN 'adminfara' THEN 'farabet' WHEN 'adminbtc' THEN 'betcoin'
        WHEN 'adminzeus' THEN 'ofizeus' WHEN 'admbigwin' THEN 'bigwin' WHEN 'adminbigwin' THEN 'bigwin'
        WHEN 'adminimperio' THEN 'bigwin' WHEN 'imperio' THEN 'bigwin'
        WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet' WHEN 'zeus' THEN 'ofizeus'
        WHEN 'zeusroyal' THEN 'royal' ELSE lower(trim(p.agente)) END AS panel
    FROM casino_segmentation_players p JOIN names n ON n.username=p.username_lower
  ), unique_panels AS (
    SELECT username_lower,panel,min(id::text)::uuid AS player_id FROM (
      SELECT username_lower,panel,id FROM players
      UNION SELECT username_lower,lower(trim(agente)),id FROM players
    ) names GROUP BY username_lower,panel HAVING count(DISTINCT id)=1
  )
  SELECT e.id AS contact_id,p.platform,p.username_lower
  FROM explicit e JOIN players p ON p.username_lower=e.username AND p.platform=e.platform
  UNION
  SELECT e.id,p.platform,p.username_lower FROM explicit e
  JOIN unique_panels up ON up.username_lower=e.username AND up.panel=e.panel
  JOIN players p ON p.id=up.player_id WHERE e.platform IS NULL
  UNION
  SELECT e.id,p.platform,p.username_lower FROM explicit e
  JOIN players p ON p.username_lower=e.username AND p.name_count=1
  WHERE e.platform IS NULL AND e.panel IS NULL
  UNION
  SELECT t.id,p.platform,p.username_lower FROM tokens t
  JOIN players p ON p.username_lower=t.username AND p.name_count=1
  LEFT JOIN explicit e ON e.id=t.id AND e.username=t.username
  WHERE e.id IS NULL AND t.username NOT IN ('farabet','betcoin','bigwin','royal','ofizeus','zeus','zeusroyal','btcuno','btcdos','adminbet','surmar','lemon','apolo','horus','peaky','soporte','reclamos','linea','admin','mismo','usuario','titular','carga','mucho')`
