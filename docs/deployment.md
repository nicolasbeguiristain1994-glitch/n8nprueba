# Deployment

## Overview

The `frontend/` directory is deployed to Railway as a Docker container.
Railway builds via the `Dockerfile` (configured in `frontend/railway.toml`).

Build command: `npm run build` (Next.js production build)
Start command: `npm run start` → `node index.js` → spawns Next.js on `$PORT`

---

## Recommended environments

| Environment | Purpose |
|---|---|
| staging | Test deploys, migrations, and new features before production |
| production | Live traffic — changes require pre-deploy checklist |

Each environment should have its own Railway service and its own database.

---

## Required Railway environment variables

Set these in Railway → Service → Variables for each environment:

```
AUTH_USERNAME
AUTH_PASSWORD
AUTH_SECRET

DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_PASSWORD
DB_POOL_MAX
DB_CONNECTION_TIMEOUT_MS
DB_IDLE_TIMEOUT_MS

N8N_URL
EVOLUTION_URL
EVOLUTION_API_KEY
EVOLUTION_GLOBAL_API_KEY
EVOLUTION_WEBHOOK_SECRET
NEXT_PUBLIC_EVOLUTION_MANAGER_URL

NODE_ENV=production
PORT          ← Railway sets this automatically
```

---

## Pre-deploy checklist

Before deploying to **any** environment:

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm run build` succeeds
- [ ] All new DB migrations have been reviewed and tested on staging
- [ ] All required env vars are present in the target Railway service
- [ ] `EVOLUTION_WEBHOOK_SECRET` is configured in the Evolution API webhook settings
- [ ] `N8N_URL` points to the correct n8n instance for this environment
- [ ] Any breaking API changes are coordinated with n8n workflow owners

---

## Deploy flow

1. Merge PR to `main` (CI must pass)
2. Railway auto-deploys `main` to staging (if connected)
3. Smoke test staging — check campaigns, conversations, webhook
4. Promote to production in Railway dashboard (or trigger manual deploy)

---

## Rollback

**App:** In Railway → Deployments, click the previous deployment → Redeploy.

**Database:** Do **not** blindly roll back DB migrations — most are irreversible
(adding columns, creating indexes). If data was corrupted, restore from a backup
taken before the migration ran, rather than trying to reverse the migration.

Before any migration that drops columns or tables, take a manual snapshot.

---

## Build notes

- The Docker image uses a multi-stage build (`FROM node:20-alpine`).
- The final image copies the Next.js standalone output — `server.js` is the real entrypoint in Docker builds; `index.js` is the Railway/Nixpacks entrypoint.
- `NEXT_PUBLIC_*` variables are **inlined at build time** — they must be set in Railway before the build runs, not just at runtime.
- If `next/font/google` is used, builds require outbound network access to Google Fonts. Consider switching to `next/font/local` if CI or isolated build environments block outbound connections.
