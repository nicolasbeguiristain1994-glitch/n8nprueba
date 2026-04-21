# Development Guide

## Required tools

| Tool | Version |
|---|---|
| Node.js | 20 LTS (matches Dockerfile and nixpacks.toml) |
| npm | 10+ (bundled with Node 20) |
| PostgreSQL | Access to a dev/staging DB (local or Supabase) |

Check your version:
```bash
node -v   # should print v20.x
npm -v
```

---

## Install

```bash
cd frontend
npm install
```

---

## Run dev server

```bash
cd frontend
npm run dev
# → http://localhost:3000
```

Requires `frontend/.env.local` with at minimum `DB_*`, `AUTH_*`, and `N8N_URL`.
See [environment.md](environment.md) for the full variable list.

---

## Typecheck and build validation

Run both before every PR:

```bash
cd frontend
npx tsc --noEmit   # must produce no errors
npm run build      # must succeed
```

The CI pipeline runs these automatically on every PR and push to `main`.

---

## Branch workflow

```
main ← merge via PR only (no direct pushes)
  └── feature/your-feature-name
  └── fix/short-bug-description
  └── chore/task-description
```

1. Branch off `main`
2. Commit with conventional prefixes (see [CONTRIBUTING.md](../CONTRIBUTING.md))
3. Open a PR — CI runs typecheck + build
4. At least one review before merge

---

## Module ownership areas

| Area | Key files |
|---|---|
| Campaigns processor | `frontend/app/api/campaigns/[id]/send/route.ts` |
| Contacts / import / lists | `frontend/app/api/contacts/`, `frontend/app/api/contacts/import/` |
| Conversations / webhook | `frontend/app/api/conversations/`, `frontend/app/api/webhook/evolution/` |
| WhatsApp lines / QR | `frontend/app/api/lines/`, `frontend/app/api/lines/qr/` |
| Warmup scheduler | `frontend/app/api/warmup/` |
| Auth | `frontend/middleware.ts`, `frontend/app/api/auth/` |
| DB pool | `frontend/lib/db.ts` |
| Infra / Railway / n8n / Evolution | `frontend/Dockerfile`, `frontend/railway.toml`, `scripts/ops/` |

---

## Coding guidelines

**SQL**
- Always use parameterized queries (`$1`, `$2`, …). Never interpolate user input into SQL strings.
- Prefer data-modifying CTEs over multiple round-trips for atomic operations.
- Use `FOR UPDATE SKIP LOCKED` when claiming rows from a queue.

**Logging**
- Do not log full phone numbers, auth tokens, or API keys.
- Use structured log prefixes: `[route-name]` e.g. `[/api/campaigns/send]`.

**Input validation**
- Validate all POST/PATCH body fields at the top of each route handler.
- Return `400` with `{ error: "..." }` on bad input before touching the DB.

**Error handling**
- Wrap `await` calls in `try/catch` in route handlers — unhandled rejections crash the route.
- Background processors (`processInBackground`) must use `try/finally` to release locks.

**TypeScript**
- Avoid `any`. Use `unknown` and narrow explicitly.
- Check `rows.length` before accessing `rows[0]`.

**Environment**
- Server-only secrets use plain `process.env.VAR_NAME`.
- Client-visible config uses `NEXT_PUBLIC_` prefix — never put secrets there.
