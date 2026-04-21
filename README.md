# WhatsApp Automation Platform

WhatsApp automation dashboard for iGaming operations in LATAM.
Manages campaigns, contact lists, conversation inbox, WhatsApp line QR linking, and a warmup scheduler.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend / API | Next.js 16 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| Database | PostgreSQL — raw `pg` pool, no ORM |
| Messaging | Evolution API (WhatsApp gateway) via n8n webhooks |
| Workflow engine | n8n (self-hosted) |
| Auth | HMAC-SHA256 signed session cookies, Edge middleware |
| Deployment | Railway (Docker / Nixpacks) |

---

## Repository structure

```
/frontend          → Next.js app (source of truth for product logic)
  /app             → App Router pages and API routes
  /components      → UI components (shadcn/ui)
  /lib             → DB pool, utilities
  middleware.ts    → Auth / session guard
/db
  /schema          → init.sql baseline DDL (may lag behind migrations)
  /migrations      → Numbered SQL migration files (source of truth)
/scripts/ops       → run-migrations.mjs, import helpers, init scripts
/docs              → Developer documentation
/n8n               → Workflow specs and credential templates
/workflows         → n8n JSON exports
```

---

## Requirements

- Node.js 20 LTS
- npm 10+
- PostgreSQL access (Supabase in production; local PG for development)
- Railway CLI (optional, for deploys)

---

## Local setup

```bash
# 1. Clone
git clone https://github.com/YOUR_ORG/whatsapp-automation-platform.git
cd whatsapp-automation-platform

# 2. Configure environment
cp .env.example frontend/.env.local
# Edit frontend/.env.local with real values (never commit it)

# 3. Install dependencies
cd frontend
npm install

# 4. Run dev server
npm run dev
# → http://localhost:3000
```

---

## Environment variables

All variables are documented in [docs/environment.md](docs/environment.md).
Use `.env.example` as the template — never commit `.env.local` or any file with real secrets.

---

## Typecheck and build

```bash
cd frontend
npx tsc --noEmit   # type check
npm run build      # production build
```

Both must pass before opening a PR.

---

## Database migrations

Migrations live in `db/migrations/` and are numbered sequentially.
The runner script tracks applied migrations in a `_migrations` table.

```bash
# From repo root — requires DB_POSTGRESDB_* vars in .env
node scripts/ops/run-migrations.mjs --dry-run   # preview
node scripts/ops/run-migrations.mjs             # apply
```

See [docs/database.md](docs/database.md) for full details and safety rules.

---

## Deployment

The frontend deploys to Railway via Docker.
See [docs/deployment.md](docs/deployment.md) for the full checklist.

---

## Documentation

| Document | Purpose |
|---|---|
| [docs/development.md](docs/development.md) | Local dev setup, coding guidelines, branch workflow |
| [docs/environment.md](docs/environment.md) | All environment variables, how to manage secrets |
| [docs/database.md](docs/database.md) | Schema, migrations, inspection commands |
| [docs/deployment.md](docs/deployment.md) | Railway deploy checklist, rollback |
| [docs/security.md](docs/security.md) | Security rules, auth overview, incident checklist |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch naming, commit style, PR checklist |

---

## Security warning

**Never commit `.env` files, API keys, or credentials to this repository.**
Real secrets belong in Railway environment variables or a secrets manager.
See [docs/security.md](docs/security.md).

---

*Internal repository — do not distribute.*
