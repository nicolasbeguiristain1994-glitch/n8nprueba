-- migrate: transactional
-- Generated with Supabase CLI: 20261016000259_contact_accounts_agent_consent.sql.
SELECT pg_advisory_xact_lock(hashtext('casino-segmentation'));
-- Contacts retain their original IDs/history. Only explicit, unambiguous account
-- identities are split; conflicting historical phones stay available for review.
CREATE OR REPLACE FUNCTION public.contact_agent_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT CASE lower(trim(value))
    WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet'
    WHEN 'zeus' THEN 'ofizeus' WHEN 'zeusroyal' THEN 'royal'
    WHEN 'adminbtc' THEN 'betcoin' WHEN 'adminzeus' THEN 'ofizeus'
    WHEN 'adminroyal' THEN 'royal' WHEN 'admbigwin' THEN 'bigwin'
    WHEN 'adminfara' THEN 'farabet' WHEN 'amdfarabet' THEN 'farabet'
    WHEN 'adminimperio' THEN 'imperio' ELSE NULLIF(lower(trim(value)),'') END
$$;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS account_username text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS account_origin_id uuid;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_key text;
-- Preserve an exact recovery record only for rows being split/normalized.
CREATE TABLE IF NOT EXISTS contact_account_migration_audit (
  contact_id uuid PRIMARY KEY, original_record jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE contact_account_migration_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON contact_account_migration_audit FROM PUBLIC,anon,authenticated;
GRANT ALL ON contact_account_migration_audit TO service_role;

-- Consent is stored independently of contact imports and of the sending line.
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS agent_code text;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'global';
ALTER TABLE cloud_opt_outs ADD COLUMN IF NOT EXISTS agent_code text;
ALTER TABLE cloud_opt_outs ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'global';
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS agent_code text;
ALTER TABLE automation_message_jobs ADD COLUMN IF NOT EXISTS agent_code text;
UPDATE campaign_recipients r SET agent_code=public.contact_agent_key(c.panel)
  FROM contacts c WHERE c.id=r.contact_id AND r.agent_code IS NULL;
-- Preserve the historical send identity before any contact is split.
UPDATE whatsapp_messages m SET metadata=COALESCE(m.metadata,'{}') || jsonb_build_object('agent_code',r.agent_code)
  FROM campaign_recipients r WHERE r.campaign_id=m.campaign_id AND r.contact_id=m.contact_id
    AND r.agent_code IS NOT NULL AND m.metadata->>'agent_code' IS NULL;
UPDATE blacklist b SET agent_code=x.agent,scope_key='agent:'||x.agent FROM (
  SELECT b.id,min(r.agent_code) agent FROM blacklist b JOIN campaign_recipients r
    ON r.campaign_id=b.campaign_id AND regexp_replace(r.phone_number,'[^0-9]','','g')=b.phone_number_normalized
  WHERE b.source='automatic' AND r.agent_code IS NOT NULL GROUP BY b.id HAVING count(DISTINCT r.agent_code)=1
) x WHERE b.id=x.id;
UPDATE cloud_consent_log l SET metadata=l.metadata || jsonb_build_object('scope','agent','agent_code',b.agent_code)
  FROM blacklist b WHERE l.metadata->>'blacklist_id'=b.id::text AND b.agent_code IS NOT NULL;
UPDATE cloud_opt_outs o SET agent_code=b.agent_code,scope_key=b.scope_key FROM blacklist b
  WHERE o.contact_phone IN (b.phone_number_normalized,'+'||b.phone_number_normalized)
    AND b.agent_code IS NOT NULL AND EXISTS(SELECT 1 FROM cloud_consent_log l
      WHERE l.metadata->>'blacklist_id'=b.id::text AND l.phone_number_id=o.phone_number_id);
DROP INDEX IF EXISTS idx_blacklist_active_phone;
CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_active_scope ON blacklist(phone_number_normalized,scope_key) WHERE removed_at IS NULL;
ALTER TABLE blacklist DROP CONSTRAINT IF EXISTS blacklist_scope_valid;
ALTER TABLE blacklist ADD CONSTRAINT blacklist_scope_valid CHECK (
  (scope_key='global' AND agent_code IS NULL AND source_key IS NULL) OR
  (agent_code IS NOT NULL AND scope_key='agent:'||agent_code) OR
  (agent_code IS NULL AND source_key IS NOT NULL AND scope_key='source:'||source_key));

-- Match panel + username, keeping aliases/platform evidence for that account.
CREATE TEMP TABLE account_split_candidates ON COMMIT DROP AS
  SELECT c.id AS original_id,public.contact_agent_key(a->>'panel') agent,lower(trim(a->>'username')) username,
    jsonb_agg(DISTINCT a || jsonb_build_object('panel',public.contact_agent_key(a->>'panel'))) accounts
  FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
  WHERE c.deleted_at IS NULL AND NULLIF(trim(a->>'username'),'') IS NOT NULL AND public.contact_agent_key(a->>'panel') IS NOT NULL
  GROUP BY c.id,public.contact_agent_key(a->>'panel'),lower(trim(a->>'username'));
CREATE INDEX ON account_split_candidates(original_id);
CREATE INDEX ON account_split_candidates(agent,username);
-- Any ambiguous account holds its whole legacy record for explicit review.
CREATE TEMP TABLE account_split_safe ON COMMIT DROP AS
  SELECT a.*,row_number() OVER(PARTITION BY a.original_id ORDER BY
    (a.agent=public.contact_agent_key(c.panel)) DESC,a.agent,a.username) rn
  FROM account_split_candidates a JOIN contacts c ON c.id=a.original_id
  WHERE NOT EXISTS (SELECT 1 FROM account_split_candidates bad JOIN account_split_candidates other
    ON other.agent=bad.agent AND other.username=bad.username AND other.original_id<>bad.original_id
    WHERE bad.original_id=a.original_id);
CREATE INDEX ON account_split_safe(original_id);
ANALYZE account_split_safe;
INSERT INTO contact_account_migration_audit(contact_id,original_record)
  SELECT c.id,to_jsonb(c) FROM contacts c WHERE c.id IN(SELECT original_id FROM account_split_safe) ON CONFLICT DO NOTHING;
DROP INDEX IF EXISTS idx_contacts_phone_unique;
-- Clone only account data. Histories and campaign snapshots keep original IDs.
INSERT INTO contacts(external_id,phone_number,first_name,panel,panels_assigned,casino_accounts,
  account_username,account_origin_id,identity_key,status,opt_in_marketing,opt_in_sms,do_not_contact,
  platform_source,linea,linea_sub,platforms,created_at,updated_at)
  SELECT gen_random_uuid()::text,c.phone_number,a.username,a.agent,ARRAY[a.agent],a.accounts,
    a.username,c.id,jsonb_build_array(a.agent,a.username)::text,c.status,c.opt_in_marketing,c.opt_in_sms,c.do_not_contact,
    'account-split',CASE WHEN a.agent=public.contact_agent_key(c.panel) THEN c.linea END,
    CASE WHEN a.agent=public.contact_agent_key(c.panel) THEN c.linea_sub END,
    ARRAY(SELECT DISTINCT x->>'platform' FROM jsonb_array_elements(a.accounts) x WHERE x->>'platform' IS NOT NULL),c.created_at,now()
  FROM account_split_safe a JOIN contacts c ON c.id=a.original_id WHERE a.rn>1;
-- Retain the primary account ID so notes, history and memberships are not lost.
UPDATE contacts c SET panel=a.agent,panels_assigned=ARRAY[a.agent],casino_accounts=a.accounts,
  account_username=a.username,identity_key=jsonb_build_array(a.agent,a.username)::text,
  first_name=CASE WHEN (SELECT count(*) FROM account_split_safe s WHERE s.original_id=c.id)>1 THEN a.username ELSE c.first_name END,
  last_name=CASE WHEN (SELECT count(*) FROM account_split_safe s WHERE s.original_id=c.id)>1 THEN NULL ELSE c.last_name END
  FROM account_split_safe a WHERE c.id=a.original_id AND a.rn=1;
-- Legacy ambiguous records receive a stable private identity, never a guessed account.
UPDATE contacts SET identity_key='legacy:'||id::text WHERE identity_key IS NULL;
ALTER TABLE contacts ALTER COLUMN identity_key SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN identity_key SET DEFAULT ('legacy:'||gen_random_uuid()::text);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_identity_unique ON contacts(identity_key);
CREATE INDEX IF NOT EXISTS idx_contacts_agent_account ON contacts(panel,account_username);
-- Preserve explicit operator assignments, without granting new agents implicitly.
INSERT INTO operator_contact_visibility(operator_id,contact_id,assigned_by)
 SELECT v.operator_id,c.id,v.assigned_by FROM contacts c JOIN operator_contact_visibility v ON v.contact_id=c.account_origin_id
 JOIN users u ON u.id=v.operator_id
 WHERE c.account_origin_id IS NOT NULL AND (cardinality(u.allowed_agents)=0 OR u.allowed_agents IS NULL OR c.panel=ANY(u.allowed_agents))
 ON CONFLICT DO NOTHING;
-- Existing lists are reviewed through their saved agent filters. Never broaden
-- a manually selected list or change a running campaign's audience snapshot.
INSERT INTO contact_list_members(list_id,contact_id)
 SELECT l.id,c.id FROM contacts c JOIN contact_list_members m ON m.contact_id=c.account_origin_id
 JOIN contact_lists l ON l.id=m.list_id
 WHERE c.account_origin_id IS NOT NULL AND public.contact_agent_key(l.filters->>'panel')=c.panel
 ON CONFLICT DO NOTHING;
REVOKE ALL ON FUNCTION public.contact_agent_key(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.contact_agent_key(text) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_recipient_phone_once ON campaign_recipients(campaign_id,(regexp_replace(phone_number,'[^0-9]','','g')));

-- Discard aggregate classifications from merged accounts until recalculated.
UPDATE contacts c SET segmentation_profile=NULL,total_deposits=NULL,total_withdrawals=NULL,last_deposit_at=NULL,
  segment=CASE WHEN segment_is_manual THEN segment ELSE NULL END
  WHERE account_origin_id IS NOT NULL OR EXISTS(SELECT 1 FROM account_split_safe a
    WHERE a.original_id=c.id AND a.rn>1);
DELETE FROM contact_tags t USING contacts c WHERE t.contact_id=c.id AND t.tag LIKE 'casino:%'
  AND (c.account_origin_id IS NOT NULL OR EXISTS(SELECT 1 FROM account_split_safe a WHERE a.original_id=c.id AND a.rn>1));
UPDATE contact_lists l SET contact_count=(SELECT count(*) FROM contact_list_members m WHERE m.list_id=l.id);
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
 WHERE c.deleted_at IS NULL AND c.account_username IS NULL AND length(tok)>=4
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


-- Keep the account/sender snapshot even if a campaign recipient is later reset.
CREATE OR REPLACE FUNCTION public.snapshot_message_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.direction='outbound' AND NEW.campaign_recipient_id IS NOT NULL THEN
    SELECT COALESCE(NEW.metadata,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'agent_code',r.agent_code,'line_id',r.line_id)) INTO NEW.metadata
      FROM public.campaign_recipients r WHERE r.id=NEW.campaign_recipient_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snapshot_message_agent() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_message_agent() TO service_role;
CREATE TRIGGER whatsapp_message_agent_snapshot BEFORE INSERT ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_message_agent();
