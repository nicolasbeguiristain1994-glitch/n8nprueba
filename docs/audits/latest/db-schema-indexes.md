# F. DB Schema / Indexes Report

Generated: 2026-04-17

---

## Critical Finding: Schema Divergence

`db/schema/init.sql` defines the **baseline schema** (designed as a CRM platform), but the frontend application appears to operate against a **different, evolved schema** that was never documented in the schema files. The two are materially incompatible on the `campaigns` table.

### campaigns table — init.sql vs App expectations

| Column | init.sql | App uses |
|--------|----------|----------|
| `id` | UUID PK | ✅ |
| `name` | VARCHAR(255) | ✅ |
| `type` | campaign_type enum | ✅ |
| `status` | campaign_status enum | ✅ |
| `scheduled_start_at` | TIMESTAMPTZ | ❌ App uses `scheduled_at` |
| `started_at` | Not in init.sql | ✅ App uses this |
| `completed_at` | Not in init.sql (`ended_at` exists) | ✅ App uses `completed_at` |
| `list_id` | Not in init.sql | ✅ App uses (FK to contact_lists) |
| `message` | Not in init.sql (`template_id` exists) | ✅ App uses direct message text |
| `messages` | Not in init.sql | ✅ App uses (JSONB array) |
| `total_targets` | Not in init.sql (`total_contacts` exists) | ✅ App uses |
| `total_sent` | Not in init.sql (`messages_sent` exists) | ✅ App uses |
| `total_failed` | Not in init.sql | ✅ App uses |
| `antiblock_delay_min/max` | Not in init.sql | ✅ App uses |
| `personalize_name` | Not in init.sql | Added by migration 005 |
| `media_url`, `media_type` | Not in init.sql | App uses |

**Conclusion:** The production DB was built differently from `init.sql`. The schema files are documentation artifacts, not the actual schema. Any new DB provisioned from `init.sql` would fail immediately.

---

## Tables Used by Frontend Routes

### contacts

**Used by:** contacts routes, campaigns/send, lists  
**Key columns in queries:** `id`, `phone_number`, `first_name`, `last_name`, `status`, `opt_in_marketing`, `do_not_contact`, `segment`, `panel`, `gaming`, `linea`, `created_at`, `updated_at`

**Indexes in init.sql:**
- `idx_contacts_phone` ON (phone_number) ✅
- `idx_contacts_segment` ON (segment) WHERE active ✅
- `idx_contacts_status_active` ON (status) WHERE active ✅
- `idx_contacts_created_at` ON (created_at DESC) ✅

**Added by migration 009:**
- `idx_contacts_panel` ON (panel) WHERE NOT NULL
- `idx_contacts_gaming` ON (gaming) WHERE NOT NULL
- `idx_contacts_linea` ON (linea) WHERE NOT NULL
- `idx_contacts_status` ON (status)

**Missing / potential gaps:**
- `contacts` has a `check_phone_format` constraint in init.sql: `phone_number ~ '^\+[0-9]{10,15}$'`. The app's import route stores phones WITHOUT the `+` prefix (it strips spaces but does not enforce E.164 format). If this constraint is active in production, imports would fail for numbers without `+`.
- `contacts.segment` default in init.sql = `'casual'` (enum: casual/regular/vip/whale). Migration 002 may have added `'premium'` to the enum. The app's contacts PATCH allows `'premium'` as a valid segment but init.sql only has `whale`. **Check production enum.**

### campaigns

**Used by:** campaigns routes, send route  
**Key columns:** id, name, message, messages, status, list_id, started_at, completed_at, total_targets, total_sent, total_failed, antiblock_delay_min, antiblock_delay_max, personalize_name, media_url

**Indexes in init.sql:**
- `idx_campaigns_status` ON (status) ✅
- `idx_campaigns_created_at` ON (created_at DESC) ✅

**Missing:**
- No index on `campaigns(list_id)` — used in JOIN in `send/route.ts`
- No compound index on `campaigns(status, created_at)` — ORDER BY created_at DESC on filtered status queries

### whatsapp_messages

**Used by:** campaigns/route.ts, webhook/evolution, send, dashboard, conversations  
**Key columns:** id, contact_id, campaign_id, phone_number, message_body, direction, status, evolution_message_id, sent_at, delivered_at, read_at, failed_at, created_at

**Indexes in init.sql:**
- `idx_messages_contact_id` ON (contact_id, sent_at DESC) ✅
- `idx_messages_campaign_id` ON (campaign_id) ✅
- `idx_messages_status` ON (status, sent_at DESC) ✅
- `idx_messages_evolution_id` ON (evolution_message_id) — non-unique in init.sql

**Added by migrations:**
- `idx_messages_evolution_id_unique` (007) — partial UNIQUE index ✅
- `idx_messages_outbound_phone` (009) ON (phone_number, sent_at DESC) WHERE outbound ✅
- `idx_messages_campaign_contact` (009) ON (campaign_id, contact_id) ✅

**Missing / gaps:**
- Dashboard query scans all `whatsapp_messages` with no date filter → full table scan at scale
- `status='received'` used in webhook but not in `message_status` enum (init.sql has: queued/sent/delivered/read/failed/skipped). **Likely production schema has `received` added.**

### whatsapp_lines

**Defined by:** migration 001  
**Key columns:** id, line_key, evolution_instance, status, is_connected, msgs_sent_today, msgs_sent_hour, msg_per_day, msg_per_hour, priority

**Indexes:**
- `idx_lines_status_active` WHERE active ✅
- `idx_lines_priority` ON (priority, status) WHERE active ✅
- `idx_lines_connected` ON (is_connected) WHERE connected ✅

**Constraints:**
- `chk_line_key_format`: line_key ~ `'^line_[0-3][0-9]$'` — only allows line_01..line_39 (regex actually allows 00-39, not 01-30)
- `chk_line_status`: allowed values defined
- `chk_line_priority`: 1-10

**App vs schema:** The lines route queries `evolution_url` implicitly via `SELECT *` but the displayed columns don't include it. The `evolution_url` column (not present in init.sql) is in migration 001 — required for n8n routing.

### contact_lists / contact_list_members

**Not defined in init.sql** — must be defined in an untracked migration or via Supabase UI.  
**App expects:**
- `contact_lists(id, name, description, filters, created_at)`
- `contact_list_members(list_id, contact_id)` with UNIQUE constraint

**Migration 009 adds:**
- `idx_clm_unique` UNIQUE ON (list_id, contact_id) — implies the table exists without it
- `idx_clm_contact` ON (contact_id, list_id)

**Risk:** If `contact_lists` was not created from a migration file in this repo, a new deployment would have missing tables.

### warmup_numbers / warmup_activity_log

**Not in init.sql** — must exist in migration 002 or untracked.  
**App queries columns:** id, phone_number, instance_name, display_name, warmup_status, current_day, target_days, messages_sent_today, daily_limit, last_message_at, notes, timezone, created_at

**warmup_activity_log columns:** id, warmup_number_id, recipient, message_type, message_preview, status, warmup_day, sent_at

**No indexes documented** for warmup_activity_log — `SELECT ... WHERE warmup_number_id = $1 ORDER BY sent_at DESC LIMIT 100` would benefit from `(warmup_number_id, sent_at DESC)` index.

### campaign_recipients

**Defined by:** migration 008  
**Columns:** id, campaign_id, contact_id, phone_number, message_body, status, evolution_message_id, error_detail, attempts, locked_at, sent_at, failed_at, created_at, updated_at

**Indexes:**
- `idx_campaign_recipients_campaign` ON (campaign_id, status) ✅
- `idx_campaign_recipients_pending` ON (campaign_id, created_at) WHERE pending ✅
- UNIQUE (campaign_id, contact_id) ✅

---

## Index Coverage Summary

| Query Pattern | Index Exists? | File:Line |
|---------------|--------------|-----------|
| contacts WHERE phone_number ILIKE | idx_contacts_phone | contacts/route.ts:20 |
| contacts WHERE panel = $1 | idx_contacts_panel (009) | contacts/route.ts:22 |
| contacts WHERE gaming = $2 | idx_contacts_gaming (009) | contacts/route.ts:23 |
| contacts WHERE linea = $4 | idx_contacts_linea (009) | contacts/route.ts:24 |
| contacts ORDER BY created_at DESC | idx_contacts_created_at | contacts/route.ts:25 |
| whatsapp_messages WHERE campaign_id | idx_messages_campaign_id | campaigns/route.ts:27 |
| whatsapp_messages WHERE evolution_message_id = X | idx_messages_evolution_id_unique | webhook/evolution:151 |
| whatsapp_messages WHERE phone_number AND outbound | idx_messages_outbound_phone (009) | webhook/evolution:174 |
| contact_list_members WHERE list_id | idx_clm_unique covers this | send/route.ts:60 |
| campaign_recipients WHERE campaign_id AND status | idx_campaign_recipients_campaign | send/route.ts:107 |
| warmup_activity_log WHERE warmup_number_id | ❌ No index documented | warmup/[id]/logs:6 |
| campaigns LEFT JOIN whatsapp_messages | No compound index | campaigns/route.ts:27 |
