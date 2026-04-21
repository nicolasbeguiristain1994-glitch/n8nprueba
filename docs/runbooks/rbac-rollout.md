# RBAC v1 Rollout Runbook

## When to use this

Follow this runbook when deploying RBAC v1 (PR #11) to a new environment.
This is a one-time setup per environment. Follow staging → production order strictly.

---

## Overview of changes

RBAC v1 replaces the shared `AUTH_USERNAME`/`AUTH_PASSWORD` env-based login with
database-backed users, bcrypt passwords, and role-based access control.

**Bootstrap mode:** Until a row exists in the `users` table, the login route
automatically falls back to the env vars. Bootstrap mode disappears the moment
any user is created. There is no separate flag to flip.

**Session cookie:** The new cookie is named `session` (was `auth_token`).
Middleware reads both during the transition; only `session` is written.
Existing sessions with `auth_token` will expire naturally (max 7 days).

---

## Required access

- [ ] Doppler access for the target environment (`stg` or `prd`)
- [ ] DB access (via Doppler or direct vars) for the target Supabase project
- [ ] Railway access to confirm deploy after merge
- [ ] A recent DB backup before touching production (see pre-production-migration.md)

---

## Staging rollout

### Step 1 — Merge PR and wait for deploy

After PR #11 is reviewed and CI passes:
- Merge with squash into `main`
- Railway staging auto-deploys on merge
- Wait for the staging deploy to complete (check Railway dashboard)

### Step 2 — Run migration 016 on staging

```bash
# Always dry-run first
doppler run --project whatsapp-difusion-bot --config stg -- \
  node scripts/ops/run-migrations.mjs --file 016 --dry-run

# Apply
doppler run --project whatsapp-difusion-bot --config stg -- \
  node scripts/ops/run-migrations.mjs --file 016
```

Verify the `_migrations` table shows `016_users_rbac.sql` applied:

```sql
SELECT filename, applied_at FROM _migrations ORDER BY id DESC LIMIT 5;
```

### Step 3 — Create first admin user on staging

Pick a strong password (min 10 chars). This is not a production credential.

```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='staging-password-min10' \
ADMIN_NAME='Admin Staging' \
doppler run --project whatsapp-difusion-bot --config stg -- \
  node scripts/ops/create-admin-user.mjs
```

### Step 4 — Smoke test staging

- [ ] `https://whatsapp-panel-staging.up.railway.app/login` loads correctly
- [ ] Login with the admin email/password works
- [ ] Dashboard loads after login
- [ ] `/users` page is accessible (admin-only)
- [ ] Logout works and redirects to `/login`
- [ ] Login with wrong password returns generic error (not "user not found")
- [ ] Visiting a protected route without cookie redirects to `/login`
- [ ] `GET /api/auth/me` returns `{ user: { id, email, role, sectors } }` with valid cookie
- [ ] `GET /api/auth/me` returns 401 without cookie

### Step 5 — Confirm bootstrap mode is gone

```bash
# Query staging DB — should show at least 1 user
SELECT COUNT(*) FROM users WHERE is_active = true;
```

If count > 0, bootstrap mode is inactive. ENV-based login no longer works.

---

## Production rollout

Only proceed after staging passes all smoke tests.

### Pre-production checklist

- [ ] Staging smoke tests all pass (Step 4 above)
- [ ] DB backup taken (see pre-production-migration.md § 1)
- [ ] Team notified
- [ ] Note current `AUTH_USERNAME` / `AUTH_PASSWORD` values — needed for bootstrap until first user is created
- [ ] Production Doppler config (`prd`) has `AUTH_SECRET` set (already set — verify with `doppler secrets get AUTH_SECRET --config prd`)

### Step 1 — Run migration 016 on production

```bash
# Dry-run first
doppler run --project whatsapp-difusion-bot --config prd -- \
  node scripts/ops/run-migrations.mjs --file 016 --dry-run

# Apply (requires production confirmation flag)
doppler run --project whatsapp-difusion-bot --config prd -- \
  node scripts/ops/run-migrations.mjs --file 016 --yes-i-know-this-is-production
```

### Step 2 — Create first admin user on production

Use the real admin credentials. Store them in a password manager before running.

```bash
ADMIN_EMAIL=admin@yourcompany.com \
ADMIN_PASSWORD='strong-unique-password-min10' \
ADMIN_NAME='Admin Principal' \
doppler run --project whatsapp-difusion-bot --config prd -- \
  node scripts/ops/create-admin-user.mjs --yes-i-know-this-is-production
```

> **Important:** Once this runs, ENV-based login stops working immediately.
> Confirm you can log in with the new credentials before considering the rollout done.

### Step 3 — Post-production verification

- [ ] `https://whatsapp-panel-production-f768.up.railway.app/login` loads
- [ ] Login with admin email/password works
- [ ] Dashboard loads
- [ ] `/users` page accessible
- [ ] Logout works
- [ ] `_migrations` table shows 016 applied
- [ ] Railway logs show no new errors in first 5 minutes

### Step 4 — Clean up bootstrap env vars (optional)

`AUTH_USERNAME` and `AUTH_PASSWORD` in Railway/Doppler are now unused.
They can be removed to reduce confusion, but leaving them does no harm since
bootstrap mode only activates when `users` table is empty.

---

## Creating additional users

After the first admin is created, use the `/users` UI to create additional users.
Roles:
- **admin** — full access, can manage users
- **operator** — operational modules (contacts, campaigns, conversations, etc.) — assign sectors
- **viewer** — read-only on assigned sectors

## Password rotation (admin user)

Re-run the create-admin-user script with the new password:

```bash
ADMIN_EMAIL=admin@yourcompany.com \
ADMIN_PASSWORD='new-strong-password' \
ADMIN_NAME='Admin Principal' \
doppler run --project whatsapp-difusion-bot --config prd -- \
  node scripts/ops/create-admin-user.mjs --yes-i-know-this-is-production
```

The script increments `session_version`, which immediately invalidates all existing
sessions for that user. They will need to log in again.

---

## Rollback

RBAC v1 does not have a simple rollback path because the `users` table cannot be
trivially removed once populated.

**If migration 016 was applied but no users were created yet:**
- Bootstrap mode is still active (env-based login still works)
- The new code is deployed but functionally equivalent to the old auth
- Rollback the app deploy in Railway to the previous version if needed

**If users were created and bootstrap mode is gone:**
- Rollback requires restoring from the DB backup taken before migration
- Then rolling back the Railway deploy to the previous version
- This is a destructive operation — coordinate with the team

**If the app deploy failed but migration ran:**
- The migration is safe to keep — it only adds a table
- Fix the code issue and redeploy rather than rolling back the DB

---

## References

- `db/migrations/016_users_rbac.sql` — schema
- `scripts/ops/create-admin-user.mjs` — first-admin bootstrap script
- `frontend/lib/auth.ts` — session token helpers
- `frontend/lib/permissions.ts` — RBAC permission rules
- `docs/runbooks/pre-production-migration.md` — DB backup and migration safety
- `docs/environment.md` — env var reference
