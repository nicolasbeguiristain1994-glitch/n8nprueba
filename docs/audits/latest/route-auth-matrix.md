# B. Route / Auth Matrix

Generated: 2026-04-17

---

## Middleware Summary

**File:** `frontend/middleware.ts`

```ts
const PUBLIC_PATHS = ['/login', '/api/auth/login']

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

**Logic:**
- Routes matching `PUBLIC_PATHS` (startsWith) or `/_next` or `/favicon` → pass through.
- All other routes → check `auth_token` cookie === `process.env.AUTH_SECRET`.
- Cookie is set at login with `httpOnly: true`, `secure: true` (prod), `sameSite: 'lax'`, `maxAge: 30 days`.

**Auth model:** The cookie value IS the secret — there is no JWT or signed token. Any attacker who discovers `AUTH_SECRET` can forge the cookie directly.

**What is public:**
- `GET /login` (page)
- `POST /api/auth/login`
- `/_next/*` (assets)
- `/favicon*`

**NOT public by middleware — requires cookie:**
- All API routes except `/api/auth/login`
- Including `/api/webhook/evolution` — this route handles its own shared-secret auth via `x-webhook-secret` header

---

## Route Matrix

| Route | Methods | Mutates | Middleware Protected | In-Route Auth | Frontend Caller | Risk Notes |
|---|---|---|---|---|---|---|
| `/api/auth/login` | POST | Sets cookie | ❌ Public | Compares username+password env vars | `login/page.tsx` | No rate limiting. Brute-forceable. |
| `/api/auth/logout` | POST | Clears cookie | ✅ Cookie required | None | (implicit) | Safe |
| `/api/campaigns` | GET, POST | POST mutates | ✅ Cookie required | None | `campaigns/page.tsx` | Safe |
| `/api/campaigns/[id]` | PATCH | Yes | ✅ Cookie required | Status allowlist: `['paused','cancelled','draft']` | `campaigns/page.tsx` | Safe |
| `/api/campaigns/[id]/contacts` | GET | No | ✅ Cookie required | None | `campaigns/page.tsx` | Safe |
| `/api/campaigns/[id]/send` | POST | Yes | ✅ Cookie required | None | `campaigns/page.tsx` | **Race risk** — double-send handled atomically but background IIFE not cancelable |
| `/api/contacts` | GET, POST | POST mutates | ✅ Cookie required | None | `contacts/page.tsx` | GET allows download=true with limit 100000 — could be slow scan |
| `/api/contacts/[id]` | PATCH, DELETE | Yes | ✅ Cookie required | Allowlist validation for segment/gaming/panel/linea | `contacts/page.tsx` | Safe |
| `/api/contacts/import` | POST | Yes | ✅ Cookie required | None | `contacts/page.tsx` | Per-row loop against DB; no batch size limit |
| `/api/conversations` | GET | No | ✅ Cookie required | None | `conversations/page.tsx` | Phone param has `REPLACE()` in SQL but still parameterized |
| `/api/dashboard` | GET | No | ✅ Cookie required | None | `app/page.tsx` | Full table scans on large tables |
| `/api/lines` | GET | No | ✅ Cookie required | None | `lines/page.tsx` | Safe |
| `/api/lines/qr` | GET, POST | POST creates instance | ✅ Cookie required | None | `lines/page.tsx`, `warmup/page.tsx` | POST accepts `globalKey` from request body — frontend passes user-supplied key to Evolution API |
| `/api/lists` | GET, POST | POST mutates | ✅ Cookie required | None | `contacts/page.tsx` | Safe |
| `/api/send` | POST | Yes | ✅ Cookie required | None | `conversations/page.tsx` | N+1: loops phones, one fetch + 1-2 DB calls per phone |
| `/api/warmup` | GET, POST | POST mutates | ✅ Cookie required | None | `warmup/page.tsx` | Safe |
| `/api/warmup/[id]` | PATCH, DELETE | Yes | ✅ Cookie required | Field allowlist: `['warmup_status','daily_limit','target_days','notes','display_name']` | `warmup/page.tsx` | Dynamic SQL but key is from allowlist |
| `/api/warmup/[id]/logs` | GET | No | ✅ Cookie required | None | `warmup/page.tsx` | Safe |
| `/api/warmup/[id]/migrate` | POST | Yes | ✅ Cookie required | None | `warmup/page.tsx` | Not idempotent — checked via existing query but race possible |
| `/api/webhook/evolution` | POST | Yes | ❌ Not in PUBLIC_PATHS but middleware protects → route performs own auth | `x-webhook-secret` header vs env var via `timingSafeEqual` | Evolution API (external) | Correct. Auth handles itself. |

---

## Routes That Are Public AND Mutate Data

Only `/api/auth/login` is public and mutates state (sets cookie). This is intentional and expected. No unintended public mutating routes found.

---

## Auth Risk Notes

1. **`/api/auth/login` — no rate limit**: Any IP can attempt unlimited logins. Single-factor (username+password in env vars). Consider adding a lockout or Cloudflare rule.

2. **Cookie value = secret**: `auth_token` cookie stores the raw `AUTH_SECRET`. If AUTH_SECRET leaks (logs, Railway dashboard), sessions are permanently compromised until the secret is rotated. A proper approach would sign a JWT with the secret, so the secret is never transmitted.

3. **`/api/auth/logout` is cookie-protected**: A user whose cookie is already expired cannot hit logout — minor UX issue, not a security risk.

4. **`/api/lines/qr` POST — user-supplied API key**: The frontend passes `globalKey` from a user-typed input field. The route uses it to call Evolution API. The server-side secret (`EVOLUTION_GLOBAL_API_KEY`) can be bypassed if the user provides their own key — this is intentional (user provides their own key). However, the route does not validate or sanitize the key before forwarding it, and errors from Evolution are forwarded to the client.
