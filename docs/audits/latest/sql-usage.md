# C. SQL Usage Report

Generated: 2026-04-17  
All queries go through `frontend/lib/db.ts` → `pool.query(sql, params)`.

---

## lib/db.ts Summary

```ts
// frontend/lib/db.ts:1-21
const pool = new Pool({
  host:                    process.env.DB_HOST,
  port:                    Number(process.env.DB_PORT || 5432),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
  ssl:                     { rejectUnauthorized: false },
  max:                     Number(process.env.DB_POOL_MAX || 5),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
  idleTimeoutMillis:       Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
})
```

- Default pool size: 5 connections.
- `ssl: { rejectUnauthorized: false }` — accepts self-signed certs (Supabase/Railway pattern, acceptable but auditor should note).
- All params use `|| default` (not `?? default`) so empty-string env vars fall back correctly.

---

## Classification Legend

- **P** = Fully parameterized — safe
- **DA** = Dynamic SQL from server-side allowlist — safe
- **DU** = Dynamic SQL with user-controlled input — risky
- **R** = Raw string interpolation of user input — injection risk

---

## Query Inventory by File

### frontend/app/api/contacts/route.ts

| Line | Classification | Query Summary | Notes |
|------|---------------|---------------|-------|
| 16-27 | **P** | SELECT contacts with 7 params | `%${search}%` is param $1, not interpolated |
| 29-36 | **P** | COUNT contacts with 5 params | Same pattern |

No issues.

### frontend/app/api/contacts/[id]/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 24 | **P** | UPDATE contacts SET segment | id = $2 |
| 29 | **P** | UPDATE contacts SET gaming | id = $2 |
| 35 | **P** | UPDATE contacts SET panel | id = $2 |
| 42 | **P** | UPDATE contacts SET linea | id = $2 |
| 56 | **P** | DELETE FROM contacts WHERE id = $1 | No soft delete |

No SQL injection risk. Note: DELETE is permanent (no `deleted_at` soft-delete).

### frontend/app/api/contacts/import/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 25-38 | **P** | INSERT ... ON CONFLICT DO UPDATE | `gaming` cast to `gaming_type` via `$5::gaming_type` — invalid values raise DB exception, caught per-row |

Loop: `for (const c of contacts)` — **one DB round-trip per contact**. For 10k+ imports this is N DB calls. Not injection risk but performance concern.

### frontend/app/api/campaigns/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 6-29 | **P** | Complex SELECT with GROUP BY, COUNT FILTER | Safe |
| 65-66 | **P** | COUNT contact_list_members | Safe |
| 71-82 | **P** | INSERT campaigns | `campaignType` passed as $7 — not validated against campaign_type enum before insert; DB enum will reject invalid values |

### frontend/app/api/campaigns/[id]/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 22-24 | **P** | UPDATE campaigns SET status | Status validated against allowlist before query |

### frontend/app/api/campaigns/[id]/send/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 15-21 | **P** | UPDATE campaigns WHERE status IN (...) | Atomic guard |
| 30-32 | **P** | SELECT campaigns WHERE id | |
| 47 | **P** | SELECT * FROM campaigns | Returns all columns — `messages` JSONB parsed as `string[] \| null` |
| 59-65 | **P** | SELECT contacts via JOIN | |
| 78-91 | **P** | INSERT campaign_recipients ON CONFLICT | |
| 96-98 | **P** | UPDATE campaigns SET total_targets | |
| 106-113 | **P** | COUNT from campaign_recipients | |
| 120 | **P** | SELECT status from campaigns | **Inside per-contact loop** — N+1 |
| 125-127 | **P** | SELECT status from campaign_recipients | **Inside per-contact loop** — N+1 |
| 173-178 | **P** | INSERT whatsapp_messages | |
| 183-189 | **P** | UPDATE campaign_recipients | |
| 197-202 | **P** | INSERT whatsapp_messages (failed) | |
| 205-210 | **P** | UPDATE campaign_recipients (failed) | |
| 219-224 | **P** | INSERT whatsapp_messages (exception) | |
| 227-232 | **P** | UPDATE campaign_recipients (exception) | |
| 238-240 | **P** | UPDATE campaigns total_sent/failed | **Inside per-contact loop** |
| 254 | **P** | SELECT status from campaigns | After loop |
| 256 | **P** | UPDATE campaigns SET completed | |

**Loop issues:**
- Lines 120, 125-127, 238-240: 3 DB queries per contact in addition to the n8n fetch. For 1000 contacts = ~3000 extra DB round-trips.

### frontend/app/api/campaigns/[id]/contacts/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 10-38 | **P** | Complex LEFT JOIN query | Safe |

### frontend/app/api/conversations/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 13-18 | **P** | SELECT messages WHERE REPLACE(phone_number,'+','') = $1 | `normalize()` strips `+` and spaces; param is safe |
| 24-33 | **P** | DISTINCT ON with ORDER BY REPLACE(...) | No user input in SQL structure |

### frontend/app/api/dashboard/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 7-42 | **P** | 4 parallel queries via Promise.all | All static SQL, no params |

Full-table scans on `whatsapp_messages` and `campaigns` — no date filter. Will degrade with large message volumes.

### frontend/app/api/lines/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 6-13 | **P** | SELECT whatsapp_lines ORDER BY priority | Safe |

### frontend/app/api/lists/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 6-12 | **P** | SELECT contact_lists with COUNT | Safe |
| 33-35 | **P** | INSERT contact_lists | `filters` is `JSON.stringify(filters \|\| criteria \|\| {})` — user-controlled JSONB, but stored not executed |
| 43-48 | **P** | SELECT contacts with criteria | All params |
| 55-59 | **P** | INSERT contact_list_members via unnest | `ids` is UUID array from DB query — safe |

### frontend/app/api/send/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 43-48 | **P** | INSERT whatsapp_messages (success) | |
| 61-66 | **P** | INSERT whatsapp_messages (failed) | |
| 78-83 | **P** | INSERT whatsapp_messages (exception) | |

Loop: one fetch + 1-3 DB calls per phone. N+1 pattern.

### frontend/app/api/warmup/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 6-11 | **P** | SELECT warmup_numbers | Safe |
| 37-46 | **P** | INSERT warmup_numbers | Safe |

### frontend/app/api/warmup/[id]/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 14-29 | **DA** | Dynamic SET clause built from allowlist | `allowed = ['warmup_status','daily_limit','target_days','notes','display_name']` — only allowed keys used as column names. Values are parameterized. **Safe.** |
| 44 | **P** | DELETE warmup_numbers | Safe |

### frontend/app/api/warmup/[id]/logs/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 6-12 | **P** | SELECT warmup_activity_log | Safe |

### frontend/app/api/warmup/[id]/migrate/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 8-10 | **P** | SELECT warmup_numbers | Safe |
| 17-18 | **P** | SELECT whatsapp_lines WHERE evolution_instance | Safe |
| 27-31 | **P** | INSERT whatsapp_lines | `line_key` is derived via `.toLowerCase().replace(/[^a-z0-9-]/g, '-')` from `instance_name` — sanitized before use |
| 34-35 | **P** | UPDATE warmup_numbers | Safe |

### frontend/app/api/webhook/evolution/route.ts

| Line | Class | Query | Notes |
|------|-------|-------|-------|
| 67-75 | **P** | UPDATE whatsapp_messages SET evolution_message_id | fromMe path |
| 98-103 | **P** | INSERT whatsapp_messages ON CONFLICT | Idempotent |
| 151-160 | **P** | UPDATE by evolution_message_id | |
| 166-183 | **P** | UPDATE by phone fallback | |

---

## Summary of Risks

### N+1 Query Loops

| File | Loop | Queries/Iteration |
|------|------|-------------------|
| `contacts/import/route.ts:20` | per contact | 1 upsert |
| `campaigns/[id]/send/route.ts:118` | per recipient | 1 status check + 1 recipient check + 1 n8n call + 1-2 DB inserts + 1 progress UPDATE = ~5 |
| `send/route.ts:23` | per phone | 1 n8n call + 1-2 DB inserts |

### SELECT-then-INSERT/UPDATE Races

| Location | Pattern | Risk |
|----------|---------|------|
| `contacts/import/route.ts` | upsert with ON CONFLICT | No race — atomic |
| `warmup/[id]/migrate/route.ts:17-27` | SELECT existing THEN INSERT | Race window between check and insert if called concurrently — duplicate key error possible |
| `contacts/route.ts POST:59-60` | SELECT existing THEN INSERT | Same — race on concurrent add of same phone |
| `campaigns/[id]/send/route.ts:15-21` | Atomic UPDATE with status guard | Safe — handled by UPDATE...WHERE status IN |

### Missing Error Handling

| Location | Missing |
|----------|---------|
| `campaigns/page.tsx:59,61` | `fetch('/api/campaigns')` / `fetch('/api/lists')` — no `.catch()` / no `res.ok` check |
| `warmup/page.tsx:84` | `.catch(() => ({ numbers: [] }))` — swallows all errors silently |
| `campaigns/[id]/send/route.ts:96-98` | `UPDATE campaigns SET total_targets` — no try/catch, unhandled rejection inside IIFE |
