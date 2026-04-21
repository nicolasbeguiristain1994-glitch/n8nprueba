# Database

## Source of truth

`db/migrations/` is the authoritative schema history.
Files are numbered sequentially and tracked in a `_migrations` table.

> **Warning:** `db/schema/init.sql` may lag behind the live schema.
> Do not use it alone to rebuild a production database — always apply migrations on top.
> Before any fresh production rebuild, reconcile `init.sql` with the current migration state.

---

## Migration files

```
db/migrations/
  001_whatsapp_lines.sql
  002_sequence_engine.sql
  003_import_and_inactivity.sql
  004_human_handoff.sql
  005_campaign_personalize_name.sql
  006_contacts_linea.sql
  007_evolution_id_unique.sql
  008_campaign_recipients.sql
  009_performance_indexes.sql
  010_message_status_received.sql
  011_contacts_phone_unique.sql
  012_whatsapp_lines_evolution_unique.sql
  013_campaign_recipients_durability.sql
  014_campaign_durability_idempotency.sql
```

---

## Running migrations

The runner (`scripts/ops/run-migrations.mjs`) connects using `DB_POSTGRESDB_*` vars,
creates a `_migrations` tracking table, and skips already-applied files.

```bash
# From repo root — requires DB_POSTGRESDB_* in .env

# Preview what would run (no DB changes)
node scripts/ops/run-migrations.mjs --dry-run

# Apply all pending
node scripts/ops/run-migrations.mjs

# Apply only one file
node scripts/ops/run-migrations.mjs --file 014
```

> When adding new migration files, append them to the `MIGRATIONS` array in `scripts/ops/run-migrations.mjs` to keep the runner in sync.

---

## Migration safety rules

1. **Never run production migrations without team approval.**
2. **Always take a DB backup before migrating production.**
3. Test on staging first.
4. If a migration adds a `NOT NULL` column to a large table, check row counts and lock implications first.

### Pre-flight for migration 011 (contacts unique phone)

> **Warning:** Migration 011 adds a `UNIQUE` constraint on `contacts.phone_number`.
> It will **fail and roll back** if any duplicate phone numbers exist in the table.
> Run this query before applying the migration to production — it must return zero rows:

```sql
SELECT phone_number, COUNT(*)
FROM contacts
GROUP BY phone_number
HAVING COUNT(*) > 1;
```

If duplicates are found, resolve them (merge or delete) before running the migration.
Do not skip this check — a failed migration mid-transaction can leave the DB in an inconsistent state if other statements were batched with it.

---

## Inspecting the schema

Connect with psql (or your SQL client of choice) and run:

```sql
\dt                      -- list all tables
\d contacts              -- contacts table structure
\d campaigns             -- campaigns table structure
\d whatsapp_messages     -- messages table structure
\d campaign_recipients   -- campaign recipient queue

-- Check applied migrations
SELECT filename, applied_at, duration_ms FROM _migrations ORDER BY id;
```

---

## Environments

| Environment | DB |
|---|---|
| Local dev | Local PostgreSQL or a personal Supabase project |
| Staging | Separate Supabase project — never share with production |
| Production | Production Supabase project — restricted access |

Keep staging and production databases strictly separate.
Never point local dev at the production DB.
