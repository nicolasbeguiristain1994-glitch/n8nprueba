# H. Verification Commands

Generated: 2026-04-17  
Working directory: `/Users/nicobegui/Desktop/whatsapp-automation-platform/frontend`

---

## 1. TypeScript Check

```
Command: cd frontend && npx tsc --noEmit
Exit code: 0
Output: (none)
```

**Result: PASS — zero type errors.** ✅

---

## 2. Production Build

```
Command: cd frontend && npm run build
Exit code: 0
```

Full route output:
```
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/auth/login
├ ƒ /api/auth/logout
├ ƒ /api/campaigns
├ ƒ /api/campaigns/[id]
├ ƒ /api/campaigns/[id]/contacts
├ ƒ /api/campaigns/[id]/send
├ ƒ /api/contacts
├ ƒ /api/contacts/[id]
├ ƒ /api/contacts/import
├ ƒ /api/conversations
├ ƒ /api/dashboard
├ ƒ /api/lines
├ ƒ /api/lines/qr
├ ƒ /api/lists
├ ƒ /api/send
├ ƒ /api/warmup
├ ƒ /api/warmup/[id]
├ ƒ /api/warmup/[id]/logs
├ ƒ /api/warmup/[id]/migrate
├ ƒ /api/webhook/evolution
├ ○ /campaigns
├ ○ /contacts
├ ○ /conversations
├ ○ /lines
├ ○ /login
└ ○ /warmup
```

**Result: PASS — all 20 API routes compiled, all 6 pages pre-rendered.** ✅

---

## 3. Lint

```
Command: cd frontend && npm run lint
Exit code: N/A
Output: npm error Missing script: "lint"
```

**Result: No lint script configured.** No ESLint configuration found. Recommend adding `eslint` + `eslint-config-next`.

---

## 4. Key rg Commands Used During Audit

```bash
# Find all API callers for each route
rg "api/campaigns" frontend/app --include="*.tsx" -n
rg "api/send" frontend/app --include="*.tsx" -n
rg "api/webhook" frontend/app --include="*.tsx" -n

# Check res.ok usage
rg "res\.ok" frontend/app --include="*.tsx" -n

# Find lucide imports
rg "from 'lucide-react'" frontend/app --include="*.tsx" -n

# Check for hardcoded secrets / URLs
rg "NEXT_PUBLIC_" frontend --include="*.ts" --include="*.tsx" -n
rg "hardcoded\|localhost\|127\.0\.0\." frontend --include="*.ts" -n

# Check evolution_message_id usage
rg "evolution_message_id" frontend/app --include="*.ts" -n

# Check for String(e) or e.message leaks
rg "String\(e\)" frontend/app --include="*.ts" -n
rg "e\.message" frontend/app --include="*.ts" -n
```

---

## 5. Environment Variables Required (not verified in this audit)

The following env vars must be set in Railway / `.env.local`:

```
DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_PASSWORD
AUTH_USERNAME
AUTH_PASSWORD
AUTH_SECRET
N8N_URL
EVOLUTION_WEBHOOK_SECRET
EVOLUTION_URL
EVOLUTION_API_KEY          (or EVOLUTION_GLOBAL_API_KEY)
EVOLUTION_GLOBAL_API_KEY   (optional, for creating instances)
DB_POOL_MAX                (optional, default 5)
DB_CONNECTION_TIMEOUT_MS   (optional, default 5000)
DB_IDLE_TIMEOUT_MS         (optional, default 30000)
```

**Note:** `NODE_ENV` must be `production` for the cookie `secure` flag to activate.

---

## 6. Hardcoded Values Found

```
frontend/app/lines/page.tsx:22
frontend/app/warmup/page.tsx:35
const EVO_MANAGER = 'https://evolution-api-production-ec6b.up.railway.app/manager'
```

This is the Evolution Manager URL hardcoded in two page files. If the Evolution API is redeployed to a new Railway URL, this link will break. Not a security risk (it's a link for the user to open) but a maintenance concern.
