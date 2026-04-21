# I. Suggested Audit Starting Points

Generated: 2026-04-17

---

## Top 10 Files to Inspect First

| Priority | File | Why |
|----------|------|-----|
| 1 | `frontend/app/api/campaigns/[id]/send/route.ts` | Most complex route. Background IIFE, N+1 queries per contact, crash/resume behavior, duplicate-send risks. Most likely source of operational bugs. |
| 2 | `frontend/app/api/webhook/evolution/route.ts` | External-facing endpoint. Auth is implemented but the `'received'` status value may fail enum validation. `fromMe` matching race window. Empty phone/ID edge cases. |
| 3 | `frontend/middleware.ts` | Simple but critical. Cookie = secret = raw env var. No expiry refresh. No CSRF protection (relying on sameSite:lax). |
| 4 | `db/schema/init.sql` vs production DB | Init.sql is out of sync with the live schema. Must be verified against production. New deployments from this file would fail. |
| 5 | `frontend/app/api/auth/login/route.ts` | No rate limiting. Plain-text comparison (not timing-safe). Credentials stored as env vars — fine, but brute-force is possible. |
| 6 | `frontend/app/api/warmup/[id]/migrate/route.ts` | SELECT-then-INSERT without transaction. Race on concurrent migration calls. Also has side effect of mutating `whatsapp_lines`. |
| 7 | `frontend/app/api/contacts/import/route.ts` | N+1 per-contact loop. No batch size limit — a 50k-row import would hold a DB connection for minutes. |
| 8 | `frontend/app/api/lines/qr/route.ts` | Forwards `globalKey` from request body to Evolution API. Error responses from Evolution API forwarded as `String(e)` — may leak internal details. |
| 9 | `frontend/app/api/campaigns/route.ts` GET | Full JOIN across `whatsapp_messages` with GROUP BY and COUNT FILTER for every campaign. At 100k+ messages this will be slow with no date filter. |
| 10 | `frontend/app/api/dashboard/route.ts` | `Promise.all` of 4 full-table scans including COUNT on `whatsapp_messages` with no WHERE filter. First page loaded by every user. |

---

## Top 10 Suspected Risks

| # | Risk | Evidence | Severity Hint |
|---|------|----------|--------------|
| 1 | **Schema divergence** — `init.sql` does not match production. Any migration from scratch will fail. `contact_lists`, `warmup_numbers`, `campaign_recipients` and the real `campaigns` columns are not in `init.sql`. | db-schema-indexes.md | High (operational) |
| 2 | **`status='received'` not in message_status enum** — webhook inserts inbound messages with `status='received'` but init.sql only has `queued/sent/delivered/read/failed/skipped`. If enum is enforced, all inbound messages fail to insert. | webhook-flow.md, init.sql:43 | High (if enum enforced) |
| 3 | **Campaign IIFE crash → stuck `running`** — Process crash leaves campaign `status='running'` forever. No dead-man timeout. Only recovery is manual pause+resume. | campaign-send-flow.md | Medium |
| 4 | **Duplicate message on crash during send** — If crash happens after `INSERT whatsapp_messages` but before `UPDATE campaign_recipients`, the recipient status stays `pending` and they receive a second message on resume. | campaign-send-flow.md | Medium |
| 5 | **No rate limit on login** — `POST /api/auth/login` has no rate limiting, lockout, or CAPTCHA. Credentials are simple env vars. Brute-force is possible from any IP. | route-auth-matrix.md | Medium |
| 6 | **Cookie value = raw secret** — `auth_token` cookie stores the raw `AUTH_SECRET`. Any request log or monitoring tool that captures cookie headers exposes the session secret. A proper approach would use a signed, expiring JWT. | route-auth-matrix.md, auth/login/route.ts:19 | Medium |
| 7 | **N+1 in campaign send loop** — 3 DB round-trips per recipient (status check, recipient check, progress update) in addition to n8n call. For 1000 contacts = ~3000 extra DB queries, plus antiblock delay. Acceptable for current scale, not for 10k+ recipients. | sql-usage.md | Low-Medium |
| 8 | **`createCampaign()` doesn't check `res.ok`** — If POST /api/campaigns fails, modal closes and form resets silently. User believes campaign was created. | frontend-ux-dead-code.md, campaigns/page.tsx:65-78 | Low (UX) |
| 9 | **`contact_lists` table not in any schema file** — If present only due to a Supabase manual migration, a new deployment or disaster recovery will not have this table, breaking campaigns entirely. | db-schema-indexes.md | Medium (operational) |
| 10 | **Evolution Manager URL hardcoded** — If Railway redeploys Evolution API to a new URL, the QR-linking flow's help link will point to the wrong address silently. | verification.md, lines/page.tsx:22 | Low (maintenance) |

---

## Unresolved Questions Requiring Production Introspection

1. **Is `message_status` enum in production updated to include `'received'`?**  
   Run: `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'message_status';`

2. **Is `contact_segment` enum in production updated to include `'premium'`?**  
   Run: `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'contact_segment';`

3. **Does `contact_lists` table exist and what is its exact DDL?**  
   Run: `\d contact_lists` or `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'contact_lists';`

4. **Have all 9 migrations (001-009) been applied to production Supabase?**  
   Run: Check each CREATE TABLE / CREATE INDEX IF NOT EXISTS for existence.

5. **Is `check_phone_format` constraint active in production?**  
   Constraint requires E.164 format (`^\+[0-9]{10,15}$`). The import route stores phones without `+`. If constraint is active, all imports will fail.  
   Run: `SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'contacts' AND constraint_type = 'CHECK';`

6. **What is the actual DB pool size on Railway?**  
   Default is 5 — but Railway may use `DATABASE_URL` or other env. Check Railway variables for `DB_POOL_MAX`.

7. **Is `EVOLUTION_WEBHOOK_SECRET` configured on all 30 Evolution instances?**  
   Need to verify webhook configuration per instance in Evolution Manager.

8. **Does `frontend/index.js` exist for production `node index.js` start command?**  
   The `start` script in package.json runs `node index.js` not `next start`. If `index.js` is missing, Railway production deployments fail on startup.

9. **Is `warmup_activity_log` populated by anything?**  
   The frontend reads logs from this table but no route writes to it. n8n workflow must be populating it. If the workflow is not running, the logs view always shows empty.

10. **Are there any campaigns currently `status='running'` that are stuck?**  
    Run: `SELECT id, name, started_at, total_sent, total_targets FROM campaigns WHERE status = 'running';`
