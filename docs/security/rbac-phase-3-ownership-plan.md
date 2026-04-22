# RBAC Phase 3 — Ownership Columns & Sector Filtering

**Status:** Planning only. Not implemented.  
**Prerequisite:** Migration 017 (rbac_audit_log) applied and verified on staging.

---

## Goal

Add row-level visibility scoping for operators and viewers.  
After this phase, an operator with `sectors: ['campaigns']` should only see
campaigns they own or that belong to their assigned scope — not all campaigns
in the system.

---

## Phase order

1. **Add nullable ownership columns** (migration 018)
2. **Write ownership on new mutations** (code change, low-risk)
3. **Add admin-visible ownership to API responses**
4. **Add SQL filtering for operators / viewers** (high-impact — test thoroughly)
5. **Expand audit entries** to include resource owner

---

## Proposed migration 018 — ownership columns

File: `db/migrations/018_ownership_columns.sql`

Candidate tables and columns:

```sql
-- campaigns
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS owned_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- contacts
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS owned_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- contact_lists
ALTER TABLE contact_lists
  ADD COLUMN IF NOT EXISTS owned_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- warmup_numbers
ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS owned_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- whatsapp_messages (for manual /api/send sends)
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS sent_by UUID REFERENCES users(id) ON DELETE SET NULL;
```

All columns are nullable. Historical rows will remain NULL.  
Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_campaigns_owned_by    ON campaigns (owned_by);
CREATE INDEX IF NOT EXISTS idx_contacts_owned_by     ON contacts  (owned_by);
CREATE INDEX IF NOT EXISTS idx_warmup_owned_by       ON warmup_numbers (owned_by);
```

---

## Backfill strategy

**Default: leave historical rows as NULL.**  
Do not auto-assign past rows to the first admin — this would misrepresent ownership.

Acceptable backfill only if:
- Admin explicitly approves in writing.
- Backfill is scoped to a specific known owner per table.
- Backfill runs in a transaction with a dry-run count first.

---

## SQL filtering design (operators / viewers)

After ownership columns exist, `canAccess` alone is not enough.  
Routes need a `scopeFilter(user)` helper that returns a SQL fragment:

```typescript
// Pseudo-code — not implemented yet
function ownershipFilter(user: SessionUser): { sql: string; params: unknown[] } {
  if (user.role === 'admin') return { sql: '', params: [] }
  // operators/viewers see only rows they own
  return { sql: 'AND owned_by = $N', params: [user.user_id] }
}
```

Inject into GET queries that currently return all rows (campaigns, contacts, warmup, lists).

**High-risk areas:**
- `GET /api/contacts` — could hide shared contacts
- `GET /api/campaigns` — multi-operator orgs may want shared campaign visibility
- `GET /api/send` results — must not leak cross-operator message history

---

## Open design questions (decide before implementing)

| Question | Options |
|---|---|
| Is ownership individual or team-based? | Start with individual `owned_by` |
| Can operators see each other's data? | No by default; admin can see all |
| What happens to contacts without an owner? | Admin-only until backfill decision |
| Should `linea` (1–12) act as a data sector? | Possible — contacts.linea already exists |
| Panel as a data sector? | Possible — contacts.panel already exists |

---

## Risks

- **Current `sectors` array** on users is a module permission list, not a data label.
  Do not confuse module access (`canAccess`) with row-level scope (ownership filter).
- **Careless filtering** could hide data that operators legitimately need to see
  (e.g., shared contact lists, global campaigns).
- **Sends must not leak** contact phone numbers across operators.
- **Backfilling production ownership** without an explicit decision is destructive —
  it changes what operators can see retroactively.
- **N+1 risk** if filtering is done in application code instead of SQL.

---

## Recommendation

Start with `created_by` / `owned_by` on **campaigns only** as a pilot:

1. Add `campaigns.owned_by UUID NULL`.
2. Write `owned_by = currentUser.id` on `POST /api/campaigns`.
3. Expose in `GET /api/campaigns` response (admin sees all + owner field; operators filter by owner).
4. Validate on staging, measure query impact with `EXPLAIN ANALYZE`.
5. Expand to contacts, warmup, lists only after campaigns filtering is stable.

Do not implement multi-team or panel-based scoping until individual ownership is working.

---

## References

- `frontend/lib/permissions.ts` — `canAccess()`, `effectivePermissions()`
- `frontend/lib/audit.ts` — audit helper (Phase 3 complete)
- `db/migrations/016_users_rbac.sql` — users table
- `db/migrations/017_audit_logging.sql` — rbac_audit_log (Phase 3 complete)
- `docs/security.md` — audit log overview
- `docs/runbooks/rbac-rollout.md` — migration runbook pattern
