# E. Webhook Flow Report

Generated: 2026-04-17

---

## File Analyzed

`frontend/app/api/webhook/evolution/route.ts`

---

## Auth / Secret Validation

**Method:** `x-webhook-secret` header  
**Implementation:** `timingSafeEqual` from `node:crypto` (lines 10-26)

```ts
const secretBuf   = Buffer.from(secret,   'utf8')
const incomingBuf = Buffer.from(incoming, 'utf8')
const lengthsMatch = secretBuf.length === incomingBuf.length
const paddedIncoming = lengthsMatch
  ? incomingBuf
  : Buffer.concat([incomingBuf, Buffer.alloc(Math.max(0, secretBuf.length - incomingBuf.length))])
if (!lengthsMatch || !timingSafeEqual(secretBuf, paddedIncoming)) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
```

**Status:** Correct. Timing-safe comparison, no length leak (padding trick is safe, length mismatch is rejected before comparison result is used). If `EVOLUTION_WEBHOOK_SECRET` is not configured → 500 returned immediately.

**Note:** Evolution API is configured to include this header on all webhook deliveries (configured during previous audit).

---

## Supported Events

### `messages.upsert` (lines 48-111)

**Purpose:** Inbound messages and outbound confirmations from Evolution.

**Expected payload shape:**
```json
{
  "event": "messages.upsert",
  "data": {
    "key": {
      "remoteJid": "5491112345678@s.whatsapp.net",
      "fromMe": false,
      "id": "EVOLUTION_MSG_ID"
    },
    "message": {
      "conversation": "text content",
      "extendedTextMessage": { "text": "..." },
      "imageMessage": { "caption": "..." },
      "videoMessage": { "caption": "..." }
    },
    "messageTimestamp": 1713300000
  }
}
```

**Logic:**
1. Ignores group messages (`jid.endsWith('@g.us')`)
2. If `fromMe=true`: updates most-recent outbound message for that phone with the Evolution message ID (lines 67-80)
3. If `fromMe=false`: inserts inbound message with `ON CONFLICT (evolution_message_id) WHERE evolution_message_id IS NOT NULL DO NOTHING`

### `messages.update` (lines 114-193)

**Purpose:** Status updates — sent → delivered → read.

**Expected payload shape:**
```json
{
  "event": "messages.update",
  "data": [
    {
      "key": { "id": "EVOLUTION_MSG_ID", "remoteJid": "..." },
      "update": { "status": 3 }
    }
  ]
}
```

Status integer mapping (line 138-148):
- ≥4 → `read`
- 3 → `delivered`
- 2 → `sent`
- String `READ/DELIVERED/SENT/FAILED/ERROR` also handled

**Logic:**
1. Update by exact `evolution_message_id` match
2. If 0 rows updated: fallback UPDATE by phone number, most recent outbound within 24h (lines 166-183)

### Other events

All other events: silently return `{ ok: true }` (line 196).

---

## Malformed Payload Handling

| Scenario | Handling |
|----------|---------|
| Invalid JSON body | `try/catch` at line 31 → 400 |
| Missing `event` field | Runtime guard line 37 → 400 |
| Missing `data` field | Runtime guard line 40 → 400 (also catches `data: null`) |
| Missing `key` in messages.upsert | Guard line 50 → 400 |
| `key.remoteJid` not a string | Falls back to empty string; `@g.us` check passes, `@s.whatsapp.net` replace produces empty phone |
| `messageTimestamp` missing | Falls back to `new Date().toISOString()` |
| `data` is array in messages.update | Handled: `Array.isArray(data) ? data : [data]` |

**Remaining risk:** If `data.key` exists but `data.key.fromMe` is undefined, `fromMe` is `undefined` (falsy) — treated as inbound. Acceptable behavior.

**Remaining risk:** Empty `remoteJid` after `@s.whatsapp.net` removal → phone = empty string. This would insert a message with `phone_number = ''` if `msgId` is also absent. The `ON CONFLICT` only deduplicates on `evolution_message_id`; an empty ID means the insert proceeds with empty phone. Low probability but possible with malformed Evolution payloads.

---

## Duplicate Prevention

### Inbound messages (messages.upsert, fromMe=false)

```sql
INSERT INTO whatsapp_messages (...)
ON CONFLICT (evolution_message_id) WHERE evolution_message_id IS NOT NULL DO NOTHING
```

**Index:** `idx_messages_evolution_id_unique` (migration 007) — partial UNIQUE on `evolution_message_id WHERE NOT NULL`.

**Gap:** If Evolution delivers with no `msgId` (empty string), `evolution_message_id = null`, the ON CONFLICT clause does not apply, and duplicate rows can be inserted. The WHERE clause on the index only covers non-null IDs.

### Status updates (messages.update)

No explicit deduplication — same UPDATE applied twice is idempotent (timestamps only advance, status only progresses). Safe.

### fromMe outbound matching (messages.upsert, fromMe=true)

```sql
UPDATE whatsapp_messages
SET evolution_message_id = $1
WHERE id = (
  SELECT id FROM whatsapp_messages
  WHERE phone_number = $2
    AND direction = 'outbound'
    AND evolution_message_id IS NULL
    AND created_at > NOW() - INTERVAL '10 minutes'
  ORDER BY created_at DESC LIMIT 1
)
```

**Race risk:** Two outbound messages to the same phone within 10 minutes both without evolution_message_id. Webhook fires for both quickly — both subqueries could return the same row before either UPDATE commits. Result: both events try to update the same row, one succeeds, the other is a no-op (row already has ID). The second message's Evolution ID is lost.

**Practical impact:** low, since messages have antiblock delay of 3-8s, but theoretically possible if `/api/send` sends to the same phone rapidly.

---

## evolution_message_id UNIQUE Constraint Status

**Exists as partial index** (migration 007):
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_evolution_id_unique
  ON whatsapp_messages(evolution_message_id)
  WHERE evolution_message_id IS NOT NULL;
```

**NOT a UNIQUE constraint on the column** — only a conditional unique index. This is correct for allowing multiple NULL values (inbound messages without IDs). However:
- The `whatsapp_messages` column definition in `db/schema/init.sql:262` has no UNIQUE constraint.
- The partial index is in `db/migrations/007_evolution_id_unique.sql` — must have been applied to production for dedup to work.

---

## Schema Alignment

`whatsapp_messages` insert in webhook:
```sql
INSERT INTO whatsapp_messages
  (phone_number, message_body, direction, status, evolution_message_id, created_at)
```

Schema (init.sql:241-286) has all these columns. ✅

Status values used: `'received'`, `'sent'`, `'delivered'`, `'read'`, `'failed'`  
Schema enum `message_status`: `'queued','sent','delivered','read','failed','skipped'`  
**Missing:** `'received'` is NOT in the `message_status` enum. Inserts with `status='received'` would fail with a DB enum violation unless `received` was added by a migration not in this repository.

This is a likely bug if `message_status` enum is enforced in production.
