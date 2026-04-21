# D. Campaign Send Flow Report

Generated: 2026-04-17

---

## Files Analyzed

- `frontend/app/api/campaigns/[id]/send/route.ts`
- `frontend/app/api/campaigns/[id]/route.ts`
- `frontend/app/api/campaigns/route.ts`
- `frontend/app/api/campaigns/[id]/contacts/route.ts`
- `frontend/app/campaigns/page.tsx`

---

## Step-by-Step Send Flow

### Step 1 — Atomic status transition (send/route.ts:15-26)

```sql
UPDATE campaigns
SET status = 'running', started_at = COALESCE(started_at, NOW())
WHERE id = $1 AND status IN ('draft', 'scheduled', 'paused')
RETURNING id
```

- If no row returned: campaign is already running/completed/cancelled → 409 returned.
- If row returned: ownership acquired, proceed.

### Step 2 — Fetch campaign details (send/route.ts:47)

```sql
SELECT * FROM campaigns WHERE id = $1
```

Returns all columns including `messages` (JSONB), `message`, `media_url`, `antiblock_delay_min/max`, `personalize_name`, `list_id`.

### Step 3 — Fetch eligible contacts (send/route.ts:59-65)

```sql
SELECT c.phone_number, c.first_name, c.id
FROM contacts c
JOIN contact_list_members clm ON clm.contact_id = c.id
WHERE clm.list_id = $1
  AND c.opt_in_marketing = true
  AND c.do_not_contact = false
  AND c.status = 'active'
```

If 0 contacts → 400 returned.

### Step 4 — Populate campaign_recipients (send/route.ts:78-91)

```sql
INSERT INTO campaign_recipients (campaign_id, contact_id, phone_number)
SELECT $1, c.id, c.phone_number FROM contacts c ...
ON CONFLICT (campaign_id, contact_id) DO NOTHING
```

Idempotent. On first run creates rows; on resume does nothing.

### Step 5 — Update total_targets (send/route.ts:96-98)

```sql
UPDATE campaigns SET total_targets = $1 WHERE id = $2
```

**No try/catch** — unhandled rejection inside IIFE if this fails.

### Step 6 — Background IIFE starts (send/route.ts:102)

Route returns `{ started: true, total: N }` immediately.
The IIFE runs in the Node.js event loop — not a Worker thread, not a queue.

### Step 7 — Seed counters from DB (send/route.ts:106-116)

```sql
SELECT COUNT(*) FILTER (WHERE status = 'sent')   AS sent_count,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
FROM campaign_recipients WHERE campaign_id = $1
```

Seeds `sent` and `failed` from persisted state so resume is accurate.

### Step 8 — Per-contact loop (send/route.ts:118-251)

For each contact:
1. **Check pause/cancel** (send/route.ts:120): `SELECT status FROM campaigns WHERE id = $1` — N+1.
2. **Check already sent** (send/route.ts:125-127): `SELECT status FROM campaign_recipients WHERE campaign_id = $1 AND contact_id = $2` — N+1.
3. **Pick message variant** (send/route.ts:136-139): random from `messages[]` pool.
4. **Personalize** (send/route.ts:141-143): `{{nombre}}` / `{{name}}` replaced.
5. **POST to n8n** (send/route.ts:147-161): `${N8N_URL}/webhook/send-whatsapp`.
6. **On success** (send/route.ts:164-189):
   - Increment `sent++`
   - INSERT into `whatsapp_messages` (direction=outbound, status=sent)
   - UPDATE `campaign_recipients` status=sent
7. **On HTTP error** (send/route.ts:191-213):
   - Increment `failed++`
   - INSERT into `whatsapp_messages` (status=failed)
   - UPDATE `campaign_recipients` status=failed
8. **On network exception** (send/route.ts:215-234):
   - Increment `failed++`
   - INSERT into `whatsapp_messages` (status=failed)
   - UPDATE `campaign_recipients` status=failed
9. **Update progress** (send/route.ts:238-240): `UPDATE campaigns SET total_sent=$1, total_failed=$2` — N+1.
10. **Antiblock delay** (send/route.ts:243-250): sleep `antiblock_delay_min..max` seconds (skip last contact).

### Step 9 — Mark completed (send/route.ts:254-257)

```sql
SELECT status FROM campaigns WHERE id = $1
-- if 'running':
UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1
```

---

## State Persistence

| State | Where Stored |
|-------|-------------|
| Campaign status | `campaigns.status` |
| Per-contact send result | `campaign_recipients.status`, `sent_at`, `failed_at`, `evolution_message_id` |
| Message record | `whatsapp_messages` rows |
| Progress counters | `campaigns.total_sent`, `campaigns.total_failed` |
| Total targets | `campaigns.total_targets` |

---

## Crash/Restart Behavior

**What happens if Node.js process crashes mid-loop:**

1. Campaign remains in `status='running'`.
2. `campaign_recipients` rows have status: some `sent`, some `failed`, remaining `pending`.
3. On next "Send/Resume" click: Step 1 transitions `paused→running` (user must first pause then resume — or if still `running`, gets 409).
4. **Problem**: A crashed campaign stays `running` forever — no dead-man timeout. User must manually pause then resume.
5. On resume: Step 7 seeds counters from DB correctly (fixed in phase 3).
6. Step 8 skips already-`sent` recipients (line 125-133).

**Unrecoverable state:** If crash happens between INSERT whatsapp_messages (success) and UPDATE campaign_recipients (success), the message record exists but recipient status stays `pending` → will be re-sent on resume → **duplicate message**.

---

## Double-Send Risk

| Scenario | Protection | Gap |
|----------|-----------|-----|
| User clicks Send twice | Atomic UPDATE (Step 1) — second click gets 409 | None — atomic guard is solid |
| Process crash + resume | recipient status check skips `sent` | Crash between message INSERT and recipient UPDATE causes re-send |
| Campaign is `running`, user pauses then immediately resumes | Two concurrent IIFEs possible if Send is called before PATCH takes effect | Possible but narrow race window |

---

## Campaign Counter Inconsistencies

The `campaigns` table has two sources of truth for sent/failed counts:
1. `campaigns.total_sent` / `campaigns.total_failed` — updated inside IIFE loop
2. `whatsapp_messages` COUNT — computed live in `GET /api/campaigns` (route.ts:13-16)

The campaigns list view uses the live `whatsapp_messages` COUNT, which is correct. The `total_sent`/`total_failed` columns are used only for the progress bar during `running` state.

**Inconsistency risk:** If a message is sent via `/api/send` (conversations tab) with a `campaign_id`, it increments `whatsapp_messages` but NOT `campaigns.total_sent`. The live COUNT then shows higher numbers than the IIFE counter. This is cosmetic during send but may confuse operators.

---

## Campaign Detail View

`GET /api/campaigns/[id]/contacts` (contacts/route.ts) uses a LEFT JOIN:

```sql
FROM campaigns camp
JOIN contact_list_members clm ON clm.list_id = camp.list_id
JOIN contacts c ON c.id = clm.contact_id
LEFT JOIN whatsapp_messages m ON m.contact_id = c.id AND m.campaign_id = camp.id
```

**Risk:** If a contact received multiple messages in this campaign (e.g., retry or bug), this returns multiple rows per contact. The UI doesn't de-duplicate. A contact could appear twice in the table.

---

## Paused Campaign Resume

1. User clicks "Reanudar" → same `sendNow()` call → Step 1 transitions `paused → running`.
2. Step 7 seeds counters from `campaign_recipients`.
3. Step 8 skips `sent` recipients by checking `campaign_recipients.status`.
4. **Contacts added to the list after initial send start are NOT included** — contacts snapshot is taken fresh at Step 3 but recipients are idempotent (ON CONFLICT DO NOTHING), so new contacts that were added to the list after the first send will be included in the next run's contact fetch but may not be in `campaign_recipients` yet, and they WILL be processed.
