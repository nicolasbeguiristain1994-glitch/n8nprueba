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

## Casino — Sincronización multi-plataforma

El sistema soporta múltiples plataformas de casino a través de una arquitectura **Factory + Strategy**. Cada plataforma tiene su propio conector; la lógica de DB (upsert, transacciones atómicas, reintentos) es compartida.

### Plataformas soportadas

| Plataforma | Tipo de conector | Base URL por defecto                     |
|------------|-----------------|------------------------------------------|
| `zeus`     | `ZeusConnector` | `https://local-admin2.zeuscasino.fun`    |
| `bet30`    | `Bet30Connector`| `https://local-admin2.bet30.world`       |

Bet30 es una skin de Zeus (misma API, distinta URL) → hereda `ZeusConnector` sin cambios.

---

### Variables de entorno requeridas

| Variable                  | Plataforma | Obligatoria | Descripción                                        |
|---------------------------|------------|-------------|---------------------------------------------------|
| `DATABASE_URL`            | todas      | ✓           | Cadena de conexión PostgreSQL para el sync script |
| `ZEUS_API_KEY`            | zeus       | ✓           | API key del panel Zeus                            |
| `ZEUS_PLAYER_TOKEN`       | zeus       | ✓           | Player token del panel Zeus                       |
| `ZEUS_API_BASE`           | zeus       |             | Override de base URL (default: config.json)       |
| `BET30_API_KEY`           | bet30      | ✓           | API key del panel Bet30                           |
| `BET30_PLAYER_TOKEN`      | bet30      | ✓           | Player token del panel Bet30                      |
| `BET30_API_BASE`          | bet30      |             | Override de base URL (default: config.json)       |
| `LOG_LEVEL`               | todas      |             | `trace`/`debug`/`info`/`warn`/`error` (def: `info`)|

Todas las variables de `ZEUS_*` y `BET30_*` también son necesarias en Railway si el **sync desde el dashboard** está habilitado (el servidor Next.js las pasa al proceso hijo al hacer spawn).

---

### Uso del script CLI

```bash
# Sincronización incremental (detecta la última fecha en DB)
node scripts/sync-casino-players-live.js --platform=zeus --auto
node scripts/sync-casino-players-live.js --platform=bet30 --auto

# Rango explícito
node scripts/sync-casino-players-live.js --platform=zeus  --desde=2026-05-01 --hasta=2026-05-12
node scripts/sync-casino-players-live.js --platform=bet30 --desde=2026-05-01 --hasta=2026-05-12

# Agentes específicos (útil para bootstrap inicial)
node scripts/sync-casino-players-live.js --platform=zeus --agentes=bigwin,royal --auto

# Debug de una sola pasada
LOG_LEVEL=debug node scripts/sync-casino-players-live.js --platform=zeus --auto
```

---

### Cómo agregar una nueva plataforma

**1. Agregar entrada en `src/config/platforms.config.json`:**
```json
{
  "name": "nueva", "type": "nueva",
  "baseUrl": "https://api.nueva.com",
  "baseUrlEnvVar": "NUEVA_API_BASE",
  "apiKeyEnvVar": "NUEVA_API_KEY",
  "playerTokenEnvVar": "NUEVA_PLAYER_TOKEN",
  "endpoint": "/api/records/movimiento-fichas",
  "timezone": "-03"
}
```

**2. Crear el conector** en `src/casino-connectors/nueva/`:
- Si la API es idéntica a Zeus → `class NuevaConnector extends ZeusConnector {}`
- Si la API es diferente → extender `BaseCasinoConnector` e implementar `fetchTransactions`, `normalizeTransactions`, `healthCheck`.

Ver guía completa en [`src/casino-connectors/README.md`](src/casino-connectors/README.md).

**3. Registrar en el factory** (`src/casino-connectors/index.js`):
```js
const CONNECTOR_MAP = { zeus: ZeusConnector, bet30: Bet30Connector, nueva: NuevaConnector }
```

**4. Agregar variables de entorno** en `.env.example` y en Railway.

**5. Agregar agentes al dashboard** en `frontend/lib/casino-agents.ts`:
```ts
const PLATFORM_AGENTS: Record<Platform, string[]> = {
  zeus:  ['bigwin', 'ofizeus', ...],
  bet30: [],
  nueva: ['agente1', 'agente2'],   // ← agregar aquí
}
```
También extender el tipo `Platform` con el nuevo nombre.

---

### Selector de plataforma (frontend)

El dashboard incluye un selector que persiste en `localStorage` bajo la clave `dashboard:platform` (default: `zeus`). Al cambiar de plataforma se recargan todos los widgets de casino filtrando por los agentes de esa plataforma.

- **Fuente de verdad de agentes:** `frontend/lib/casino-agents.ts` → `PLATFORM_AGENTS`
- **API routes afectadas:** `/api/dashboard/casino`, `/api/dashboard/casino/players`, `/api/dashboard/casino/risk`
- **Sincronización desde el dashboard:** `POST /api/dashboard/casino/sync?platform=bet30`

---

### Logging

Los conectores y el script de sincronización usan **pino** (logs JSON estructurados).

```bash
# Nivel de detalle (stdout)
LOG_LEVEL=debug   # cada fetch, cantidad de transacciones recibidas
LOG_LEVEL=info    # resumen por agente, inicio/fin de sync (por defecto)
LOG_LEVEL=warn    # solo reintentos y advertencias
LOG_LEVEL=error   # solo errores

# Los tests silencian los logs automáticamente (NODE_ENV=test → level: silent)
```

Campos presentes en cada log: `platform`, `agent` (cuando aplica), `durationMs`, `txFetched`, `txInserted`.

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
