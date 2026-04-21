# Issue 001 — Reconcile db/schema/init.sql with migrations 001–014

**Labels:** `database` `docs` `onboarding` `high-priority`

---

## Context

The collaboration docs note that `db/schema/init.sql` diverges from the live application schema.
The app currently depends on tables and columns added across migrations 001–014, including:

- Campaign recipients (`008`)
- Evolution message ID uniqueness (`007`)
- Contact phone uniqueness (`011`)
- Received message status enum value (`010`)
- Processor lock fields and campaign recipient idempotency (`013`, `014`)

## Problem

A fresh database initialized only from `db/schema/init.sql` may not match the app's expectations.
This creates risk for staging setup, disaster recovery, and new developer onboarding.

## Scope

- Review `db/schema/init.sql`.
- Review every file in `db/migrations/001` through `014`.
- Produce a reliable baseline schema **or** update docs to make migrations the only supported bootstrap path.
- Ensure the following app-required tables/columns exist from a fresh setup:
  - `contacts`
  - `campaigns`
  - `contact_lists`
  - `contact_list_members`
  - `whatsapp_messages`
  - `whatsapp_lines`
  - `warmup_numbers`
  - `warmup_activity_log`
  - `campaign_recipients`
- Ensure enum values include `message_status = 'received'`.
- Ensure indexes and constraints from migrations 007–014 are represented.

## Acceptance Criteria

- [ ] A fresh staging DB can be created reliably using documented steps.
- [ ] `db/schema/init.sql` no longer contradicts app-required columns, **or** docs clearly state it is deprecated and migrations are the only bootstrap path.
- [ ] Migrations 001–014 remain idempotent when re-run.
- [ ] `scripts/ops/run-migrations.mjs` includes all migrations (already done in companion PR).
- [ ] No production data migration is required as part of this issue.

## Risk Notes

- Do not apply destructive schema changes to production.
- Migration 011 requires a duplicate phone preflight before applying to any dataset:

```sql
SELECT phone_number, COUNT(*)
FROM contacts
GROUP BY phone_number
HAVING COUNT(*) > 1;
```

Resolve all duplicates before running the migration. See `docs/database.md` for details.

## References

- `db/schema/init.sql`
- `db/migrations/001_whatsapp_lines.sql` → `014_campaign_durability_idempotency.sql`
- `scripts/ops/run-migrations.mjs`
- `docs/database.md`
