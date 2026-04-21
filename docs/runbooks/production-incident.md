# Production Incident Runbook

## 1. Identify the issue

- Check Railway → Service → Logs for errors
- Check Evolution API → webhook delivery logs for failed calls
- Check n8n execution history for failed workflow runs
- Query DB for recent state:

```sql
-- Recent failed messages
SELECT phone_number, error_detail, created_at
FROM whatsapp_messages
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- Stuck campaigns (processor lock held > 30 min)
SELECT id, name, status, processor_locked_at
FROM campaigns
WHERE processor_locked_at IS NOT NULL
  AND processor_locked_at < NOW() - INTERVAL '30 minutes';

-- Stale sending recipients (locked > 15 min without message)
SELECT cr.id, cr.phone_number, cr.locked_at, cr.attempts
FROM campaign_recipients cr
LEFT JOIN whatsapp_messages wm ON wm.campaign_recipient_id = cr.id
WHERE cr.status = 'sending'
  AND cr.locked_at < NOW() - INTERVAL '15 minutes'
  AND wm.id IS NULL;
```

## 2. Stop active campaigns if needed

If a campaign is sending bad data or hitting the wrong audience:

```sql
-- Pause a specific campaign
UPDATE campaigns SET status = 'paused' WHERE id = 'CAMPAIGN_UUID';

-- Release the processor lock manually
UPDATE campaigns SET processor_locked_at = NULL WHERE id = 'CAMPAIGN_UUID';
```

## 3. Pause affected n8n workflows

In n8n UI: Workflows → find active workflow → toggle off.

## 4. Rotate secrets if credentials may be exposed

Follow [docs/security.md — Incident response checklist](../security.md).
At minimum: rotate `AUTH_SECRET` and `EVOLUTION_WEBHOOK_SECRET`.

## 5. Roll back the app deploy

In Railway → Service → Deployments → find the last stable deployment → Redeploy.

> **Do not roll back DB migrations** unless you have a backup taken before the migration ran.
> Most migrations (add column, add index) are safe to leave in place even when reverting the app.

## 6. Check and repair DB state

```sql
-- Release stale locks (safe to run — processor will re-pick on next trigger)
UPDATE campaigns
SET processor_locked_at = NULL
WHERE processor_locked_at < NOW() - INTERVAL '30 minutes';

-- Reset stuck sending recipients back to pending
UPDATE campaign_recipients
SET status = 'pending', locked_at = NULL
WHERE status = 'sending'
  AND locked_at < NOW() - INTERVAL '30 minutes';
```

## 7. Document the timeline

Write a brief post-mortem with:
- What happened and when
- What was rotated or changed
- Root cause (if known)
- Follow-up actions to prevent recurrence

Share with the team — do not leave incidents undocumented.
