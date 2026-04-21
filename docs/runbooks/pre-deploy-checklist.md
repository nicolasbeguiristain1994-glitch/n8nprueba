# Pre-Deploy Checklist

Run this before every deployment to staging or production.

---

## Code

- [ ] You are on the correct branch / commit
- [ ] `git pull` is up to date with `main`
- [ ] `cd frontend && npx tsc --noEmit` — no errors
- [ ] `cd frontend && npm run build` — succeeds

## Database

- [ ] Any new migrations have been reviewed and approved
- [ ] Migrations have been tested on the **staging** DB before production
- [ ] If the migration is risky (drops columns, adds NOT NULL), a DB backup has been taken
- [ ] `_migrations` table on the target DB reflects the expected state

## Railway environment

- [ ] All required env vars are present in the target Railway service (check `docs/environment.md`)
- [ ] `NEXT_PUBLIC_*` vars are set **before** the build runs (they are inlined at build time)
- [ ] `EVOLUTION_WEBHOOK_SECRET` matches the secret configured in Evolution API
- [ ] `N8N_URL` points to the correct n8n instance for this environment (staging ≠ production)

## Process

- [ ] Deploy to **staging first** — never skip staging for non-trivial changes
- [ ] Smoke test staging:
  - [ ] Login works
  - [ ] Campaigns list loads
  - [ ] Conversations inbox loads
  - [ ] Webhook endpoint responds (check Evolution → Webhook logs)
- [ ] Once staging is clean, deploy to production

## Post-deploy

- [ ] Check Railway deployment logs for errors in the first 5 minutes
- [ ] Verify at least one campaign send works end-to-end (or confirm no regressions in send path)
- [ ] Monitor for unexpected errors in Railway → Logs
