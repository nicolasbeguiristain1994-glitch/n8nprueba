# Issue 004 — Enforce dedup_key / idempotency in n8n send workflow

**Labels:** `reliability` `messaging` `medium-priority`

---

## Context

The campaign processor (`frontend/app/api/campaigns/[id]/send/route.ts`) sends a
`campaign_recipient_id` and `dedup_key` in the n8n webhook payload for every outbound message:

```json
{
  "phone": "...",
  "message": "...",
  "campaign_recipient_id": "<uuid>",
  "dedup_key": "<uuid>",
  "source": "campaign"
}
```

The `whatsapp_messages` table has a partial unique index on `campaign_recipient_id`
(migration 014) to prevent duplicate DB rows on retry.

## Problem

The deduplication only protects the **database layer**. If the n8n `send-whatsapp` webhook
workflow does not check `dedup_key` before calling Evolution API, a retry or a stale
re-delivery from n8n can result in the same message being sent to the contact **twice**,
even though the DB correctly records only one row.

This is especially relevant during:
- Campaign processor restarts (the processor re-claims `sending` rows that were mid-flight).
- n8n execution retries on transient Evolution API errors.

## Scope

1. **Audit the n8n `send-whatsapp` workflow** — check whether it already handles `dedup_key`.
2. If not, add a dedup check using one of:
   - A `Set` node that queries the DB (or a Redis key) for the `dedup_key` before calling Evolution.
   - An idempotency table in Postgres (`outbound_dedup_log`) with `dedup_key` as unique key,
     inserted with `ON CONFLICT DO NOTHING` — if 0 rows inserted, skip the Evolution call.
3. **Document the contract** — update `docs/workflows/` (or create one) describing what
   fields the `send-whatsapp` webhook expects and which are used for deduplication.

## Acceptance Criteria

- [ ] Sending the same `dedup_key` twice within a 24-hour window does not result in two
  Evolution API calls for the same message.
- [ ] The n8n workflow returns a success response on the duplicate (so the processor
  marks the recipient as `sent` rather than retrying indefinitely).
- [ ] Behavior is documented in `docs/workflows/` or equivalent n8n spec.
- [ ] No changes to the Next.js API routes — this is a n8n-side fix.

## Risk Notes

- The dedup window should be long enough to cover the campaign processor's `locked_at`
  stale timeout (currently 15 minutes) plus any n8n retry window.
- If using a DB table, add a `created_at` index and a periodic cleanup job to avoid unbounded growth.
- Test with a campaign that has at least two recipients to confirm no double-sends.

## References

- `frontend/app/api/campaigns/[id]/send/route.ts` — `sendOne` function, n8n payload
- `db/migrations/014_campaign_durability_idempotency.sql` — DB-layer dedup index
- `workflows/` — n8n workflow JSON exports
- `docs/workflows/WF-011-Sequence-Engine.md` (if applicable)
