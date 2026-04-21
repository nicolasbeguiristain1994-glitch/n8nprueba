# Security

## Sensitive data rules

- **No secrets in git.** No `.env` files, API keys, tokens, or credentials in any committed file.
- **No full phone numbers in logs.** Log last 4 digits at most, or omit entirely.
- **No production DB dumps on personal laptops** unless anonymized first.
- `NEXT_PUBLIC_*` variables are bundled into the client JS — never put secrets there.

---

## Authentication

**Session tokens**
- Generated at login as `base64url(JSON{nonce,iat,exp}).base64url(hmacSignature)`.
- Signed with HMAC-SHA256 using `AUTH_SECRET`.
- Validated on every request in `frontend/middleware.ts` (Edge-compatible Web Crypto).
- Rotating `AUTH_SECRET` immediately invalidates all active sessions.

**Protected routes**
- `middleware.ts` intercepts all routes except `/login` and `/api/auth/*`.
- No other routes should be added to the public allowlist without a security review.

**Evolution webhook**
- Incoming Evolution webhook calls must include `x-webhook-secret` matching `EVOLUTION_WEBHOOK_SECRET`.
- Validated in `frontend/app/api/webhook/evolution/route.ts`.

---

## API route security rules

| Rule | Why |
|---|---|
| Parameterized SQL only (`$1`, `$2`, …) | Prevents SQL injection |
| Validate all POST/PATCH body fields | Returns `400` before touching DB |
| External URLs from `process.env` only | Prevents SSRF from user-supplied URLs |
| No user input in SQL string interpolation | Even "safe" fields — use params |
| No broad public route prefixes | Every new public route must be explicitly listed |

---

## Rate limiting caveat

The current login rate limiter (`frontend/app/api/auth/login/route.ts`) uses in-memory state.
This means:
- Rate limit state is lost on server restart.
- It does not work correctly across multiple Railway instances.

For production with multiple replicas, replace with a Redis-backed or DB-backed limiter.

---

## Incident response checklist

If credentials may have been exposed:

1. **Rotate `AUTH_SECRET`** → invalidates all user sessions immediately
2. **Rotate `EVOLUTION_WEBHOOK_SECRET`** → update in both Railway and Evolution API settings
3. **Rotate Evolution API keys** (`EVOLUTION_API_KEY`, `EVOLUTION_GLOBAL_API_KEY`) → update in Railway
4. **Rotate n8n API keys** if `N8N_URL` was exposed
5. **Check Railway logs** for unusual traffic patterns
6. **Check DB** for unexpected `whatsapp_messages` rows or unauthorized campaign sends
7. If DB credentials were exposed: rotate in Supabase dashboard, update Railway vars, redeploy
8. Document the timeline and what was rotated in a post-mortem

---

## Dependency hygiene

- Run `npm audit` periodically in `frontend/`.
- Address `high` and `critical` advisories before they reach production.
- Pin major versions of `next`, `pg`, and auth-related packages — avoid auto-updating major versions.
