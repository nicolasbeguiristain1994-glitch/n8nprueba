// Read snapshots first; legacy sends fall back only to their own campaign recipient.
export const broadcastMessageAgentSql = (alias='wm') => `COALESCE(to_jsonb(${alias})->'metadata'->>'agent_code',
  (SELECT COALESCE(to_jsonb(recipient)->>'agent_code',to_jsonb(account)->>'panel')
    FROM campaign_recipients recipient LEFT JOIN contacts account ON account.id=recipient.contact_id
    WHERE recipient.campaign_id=${alias}.campaign_id AND regexp_replace(recipient.phone_number,'[^0-9]','','g')=regexp_replace(${alias}.phone_number,'[^0-9]','','g') LIMIT 1),
  (SELECT to_jsonb(account)->>'panel' FROM contacts account WHERE account.id::text=to_jsonb(${alias})->>'contact_id'),'')`
export const broadcastRecipientAgentSql = (alias='cr') => `COALESCE(to_jsonb(${alias})->>'agent_code',
  (SELECT to_jsonb(account)->>'panel' FROM contacts account WHERE account.id=${alias}.contact_id),'')`
