# Pre-production Migration Checklist

## When to use this

Run through this checklist every time you need to apply DB migrations to the **production** database.
Do not skip steps even for "small" migrations — a failed migration mid-transaction can require manual recovery.

---

## Required access

- [ ] SSH or tunnel access to the production Supabase project (or a machine with `DB_POSTGRESDB_*` vars set for production)
- [ ] A recent production DB backup (see below)
- [ ] Team awareness — notify the team before running migrations during business hours

---

## 1. Back up production DB first

In Supabase dashboard → your production project → **Database → Backups**.
Trigger a manual backup and confirm it completes before continuing.

Alternatively, use `pg_dump`:
```bash
pg_dump \
  "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=require" \
  --no-owner --no-acl \
  -f backup-$(date +%Y%m%d-%H%M%S).sql
```

Do not proceed until you have a usable backup.

---

## 2. Confirm Railway deploy behavior

Railway may auto-deploy when `main` is updated.
**Migrations are NOT run automatically by Railway** — the app only deploys new code.
Migrations must be run manually using `scripts/ops/run-migrations.mjs`.

To confirm your Railway deploy settings:
- Railway dashboard → your service → **Settings → Source**
- If **Branch: main** is set, any push to main triggers a code deploy (not migrations).

---

## 3. Apply to staging first

Before running on production, confirm the migration works on the staging DB:

```bash
# From repo root, with staging DB_POSTGRESDB_* vars
node scripts/ops/run-migrations.mjs --dry-run     # preview
node scripts/ops/run-migrations.mjs               # apply
```

Verify the app still works normally on staging after the migration.

---

## 4. Migration-specific preflights

### Migration 011 — `contacts.phone_number` unique constraint

> ⚠️ **This migration will fail and roll back if duplicate phone numbers exist.**

Run this query against production before applying:

```sql
SELECT phone_number, COUNT(*)
FROM contacts
GROUP BY phone_number
HAVING COUNT(*) > 1;
```

**If the query returns zero rows** → safe to proceed.

**If the query returns any rows** → stop. Resolve duplicates first:
```sql
-- Inspect duplicates
SELECT id, phone_number, first_name, created_at
FROM contacts
WHERE phone_number IN (
  SELECT phone_number FROM contacts
  GROUP BY phone_number HAVING COUNT(*) > 1
)
ORDER BY phone_number, created_at;

-- Merge or delete duplicates, then re-run the preflight query.
-- Never delete without reviewing which row is authoritative.
```

### Migration 014 — campaign durability + idempotency

Adds `campaign_recipient_id` FK column to `whatsapp_messages` and `processor_locked_at` to `campaigns`.
Both are nullable — safe to apply with live traffic. No preflight required beyond the backup.

---

## 5. Apply to production

```bash
# From repo root, with PRODUCTION DB_POSTGRESDB_* vars
node scripts/ops/run-migrations.mjs --dry-run     # always preview first
node scripts/ops/run-migrations.mjs               # apply
```

Monitor output. If any migration fails, the runner stops immediately.
Do not re-run blindly — inspect the error and the `_migrations` table first:

```sql
SELECT filename, applied_at, duration_ms FROM _migrations ORDER BY id;
```

---

## 6. Post-migration verification

- [ ] App is responding normally (Railway health check passes)
- [ ] `/api/dashboard` returns data
- [ ] Campaigns list loads
- [ ] Conversations inbox loads
- [ ] No new errors in Railway logs
- [ ] `_migrations` table shows all expected migrations applied

---

## 7. Rollback guidance

Most migrations in this project are **additive** (add column, add index, add constraint).
They cannot be reversed by re-running a previous migration.

If a migration caused a problem:
1. **Roll back the app deploy** in Railway (not the DB) if the issue is code-related.
2. **Restore from backup** if the DB state is corrupted — do not attempt manual column drops without approval.
3. Do not run `DROP COLUMN` or `DROP TABLE` unless explicitly planned and reviewed.

---

## References

- `db/migrations/` — all migration files in order
- `scripts/ops/run-migrations.mjs` — migration runner
- `docs/database.md` — schema source of truth and safety rules
- `docs/runbooks/production-incident.md` — if something goes wrong post-migration
