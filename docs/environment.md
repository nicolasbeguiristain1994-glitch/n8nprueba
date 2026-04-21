# Environment Variables

## How env files work

| File | Purpose |
|---|---|
| `.env.example` | Template committed to the repo — **no real values** |
| `frontend/.env.local` | Local development — **never commit** |
| Railway service variables | Staging and production — managed in Railway dashboard |

Copy the template to get started:
```bash
cp .env.example frontend/.env.local
# then fill in real values
```

---

## Variable reference

### Auth

| Variable | Description |
|---|---|
| `AUTH_USERNAME` | Dashboard login username |
| `AUTH_PASSWORD` | Dashboard login password |
| `AUTH_SECRET` | HMAC-SHA256 signing key for session tokens — rotate to invalidate all sessions |

Generate a strong secret:
```bash
openssl rand -hex 32
```

---

### Database (frontend API routes)

Used by `frontend/lib/db.ts` (the pg connection pool):

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_NAME` | postgres | Database name |
| `DB_USER` | postgres | Database user |
| `DB_PASSWORD` | — | Database password |
| `DB_POOL_MAX` | 5 | Max pool connections |
| `DB_CONNECTION_TIMEOUT_MS` | 5000 | Connection timeout |
| `DB_IDLE_TIMEOUT_MS` | 30000 | Idle connection timeout |

---

### Database (migration runner)

Used by `scripts/ops/run-migrations.mjs` — note the different prefix:

| Variable | Description |
|---|---|
| `DB_POSTGRESDB_HOST` | PostgreSQL host |
| `DB_POSTGRESDB_PORT` | PostgreSQL port (default 5432) |
| `DB_POSTGRESDB_DATABASE` | Database name |
| `DB_POSTGRESDB_USER` | Database user |
| `DB_POSTGRESDB_PASSWORD` | Database password |
| `DB_POSTGRESDB_SSL` | `true` for Supabase / remote hosts |

---

### Messaging

| Variable | Description |
|---|---|
| `N8N_URL` | Server-side URL for n8n webhook calls (e.g. `https://n8n.yourdomain.com`) |
| `EVOLUTION_URL` | Base URL of the Evolution API instance |
| `EVOLUTION_API_KEY` | Per-instance API key for Evolution |
| `EVOLUTION_GLOBAL_API_KEY` | Global API key — used to create new Evolution instances |
| `EVOLUTION_WEBHOOK_SECRET` | Shared secret validated in `x-webhook-secret` header |
| `NEXT_PUBLIC_EVOLUTION_MANAGER_URL` | **Client-visible** URL of the Evolution Manager panel (used for "Open Manager" button) |

---

### Runtime

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` or `production` |
| `PORT` | Port the server listens on (Railway sets this automatically) |

---

## Generating secrets

```bash
# AUTH_SECRET, EVOLUTION_WEBHOOK_SECRET
openssl rand -hex 32
```

---

## Secret management rules

- **Never share secrets in Slack, WhatsApp, email, or plain text.**
- Use a secrets manager for team sharing: [1Password](https://1password.com), [Bitwarden](https://bitwarden.com), [Doppler](https://doppler.com), or [Infisical](https://infisical.com).
- Rotate `AUTH_SECRET` if a session token may have been exposed — it immediately invalidates all active sessions.
- Rotate `EVOLUTION_WEBHOOK_SECRET` if the webhook endpoint may have been probed.
- Production secrets live only in the Railway dashboard — never in files committed to git.
