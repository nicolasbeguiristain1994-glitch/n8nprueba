# A. Repository Snapshot

Generated: 2026-04-17  
Branch: `audit/security-fixes`

---

## Git Status

```
?? .claude/
```
(No staged/unstaged source changes — only untracked `.claude/` metadata)

## Latest Commit

```
326e4c0 fix(security): phase 4 - frontend UX
```

Recent commit history:
```
326e4c0 fix(security): phase 4 - frontend UX
56a75ff fix(security): phase 3 - error handling, indexes, bulk ops, pool config
9ae2e38 fix(security): phase 2 - campaign send durability & outbound logging
48a7969 fix(security): phase 1 - webhook protection & idempotency
6442dfd chore: add docs, workflows, root package, update migration list
6bb1c26 feat: security audit fixes - phases 1-4
938fd74 chore: trigger redeploy to pick up new env vars
21158da fix: allow Evolution webhooks through middleware + improve status tracking
```

---

## Runtime Versions

- Node: v24.14.1
- npm: 11.11.0

---

## frontend/package.json

### Key Version: **Next 16.2.3** (package.json claims this; README/docs may say "Next 15" — actual installed version is 16)

```json
{
  "scripts": {
    "dev":   "next dev",
    "build": "next build",
    "start": "node index.js"      ← NOTE: uses index.js, not "next start"
  },
  "dependencies": {
    "next":         "16.2.3",
    "react":        "19.2.4",
    "react-dom":    "19.2.4",
    "pg":           "^8.20.0",
    "@types/pg":    "^8.20.0",
    "lucide-react": "^1.8.0",
    "recharts":     "^3.8.1",
    "@supabase/supabase-js": "^2.103.0",   ← imported but NOT used in frontend routes
    "xlsx":         "^0.18.5",
    "shadcn":       "^4.2.0",
    "tailwindcss":  "^4"
  }
}
```

**Notable:**
- `@supabase/supabase-js` is listed as a dependency but all DB access goes through `frontend/lib/db.ts` (raw `pg` pool) — Supabase client appears unused.
- `"start": "node index.js"` — there must be an `index.js` at the frontend root for production. Not found in glob results; if missing, production `railway start` may fail.
- No `test` script defined.
- No `lint` script defined.

---

## API Route Files (frontend/app/api)

```
frontend/app/api/auth/login/route.ts
frontend/app/api/auth/logout/route.ts
frontend/app/api/campaigns/route.ts
frontend/app/api/campaigns/[id]/route.ts
frontend/app/api/campaigns/[id]/contacts/route.ts
frontend/app/api/campaigns/[id]/send/route.ts
frontend/app/api/contacts/route.ts
frontend/app/api/contacts/[id]/route.ts
frontend/app/api/contacts/import/route.ts
frontend/app/api/conversations/route.ts
frontend/app/api/dashboard/route.ts
frontend/app/api/lines/route.ts
frontend/app/api/lines/qr/route.ts
frontend/app/api/lists/route.ts
frontend/app/api/send/route.ts
frontend/app/api/warmup/route.ts
frontend/app/api/warmup/[id]/route.ts
frontend/app/api/warmup/[id]/logs/route.ts
frontend/app/api/warmup/[id]/migrate/route.ts
frontend/app/api/webhook/evolution/route.ts
```
Total: 20 route files

---

## Frontend Page Files

```
frontend/app/page.tsx                   ← redirect/dashboard root
frontend/app/login/page.tsx
frontend/app/campaigns/page.tsx
frontend/app/contacts/page.tsx
frontend/app/conversations/page.tsx
frontend/app/lines/page.tsx
frontend/app/warmup/page.tsx
```

---

## DB Schema / Migration Files

```
db/schema/init.sql                      ← Full baseline schema (12 tables, views, triggers)
db/schema/01_core.sql                   ← (stub / placeholder only)
db/schema/02_messaging.sql              ← (stub — points to docs)
db/migrations/001_whatsapp_lines.sql    ← whatsapp_lines + line_metrics + functions
db/migrations/002_sequence_engine.sql
db/migrations/003_import_and_inactivity.sql ← import_logs, contact_tags, upsert_contact fn
db/migrations/004_human_handoff.sql
db/migrations/005_campaign_personalize_name.sql
db/migrations/006_contacts_linea.sql
db/migrations/007_evolution_id_unique.sql   ← UNIQUE partial index on evolution_message_id
db/migrations/008_campaign_recipients.sql   ← campaign_recipients table
db/migrations/009_performance_indexes.sql   ← 8 performance indexes
```

**Schema note:** `db/schema/init.sql` defines the baseline `campaigns` table with columns `scheduled_start_at`, `ended_at`, `template_id`, `total_contacts`, `messages_sent`, etc. The app's routes use completely different columns (`started_at`, `completed_at`, `list_id`, `message`, `messages`, `total_targets`, `total_sent`, `total_failed`, `antiblock_delay_min/max`, `personalize_name`). The two are incompatible — the app was built against a different, evolved schema. See `db-schema-indexes.md` for detail.
