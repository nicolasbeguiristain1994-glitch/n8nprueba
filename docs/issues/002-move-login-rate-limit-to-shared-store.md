# Issue 002 — Move login rate limiter to a shared store

**Labels:** `security` `infra` `medium-priority`

---

## Context

The current login rate limiter in `frontend/app/api/auth/login/route.ts` uses in-memory state
(a plain JS `Map` or similar) to track failed attempts per IP/username.

## Problem

In-memory rate limiters have two failure modes in production:

1. **Restart reset** — the counter resets every time Railway redeploys or restarts the service.
   An attacker who times requests around a deploy can bypass the limit entirely.
2. **Multi-instance bypass** — if Railway scales the service to more than one replica,
   each instance has an independent counter. An attacker can distribute requests across
   instances and never hit the limit on any single one.

These issues are documented in `docs/security.md`.

## Proposed Solution

Replace the in-memory counter with one of:

- **Redis** — `QUEUE_BULL_REDIS_HOST` / `QUEUE_BULL_REDIS_PORT` are already in `.env.example`.
  Use `ioredis` or the existing Bull Redis connection.
- **PostgreSQL** — insert/upsert a `login_attempts` table with TTL-based cleanup.
  No additional infrastructure needed; slightly higher latency than Redis.
- **Upstash Redis** — serverless-compatible, works well with Edge routes if the login
  route is ever moved to Edge runtime.

The chosen store must work across Railway replicas and survive restarts.

## Acceptance Criteria

- [ ] Login rate limit state survives a service restart.
- [ ] Login rate limit is shared across all Railway replicas (or Railway is confirmed single-instance).
- [ ] No new secrets are hardcoded — connection strings come from env vars.
- [ ] `docs/security.md` rate limiter caveat is updated to reflect the fix.
- [ ] `npx tsc --noEmit` and `npm run build` pass.

## Risk Notes

- This is a security hardening change — no product behavior changes for normal users.
- If using Redis, ensure the Redis instance is accessible from the Railway service (same private network or public URL with auth).
- Do not log failed login payloads — they may contain passwords submitted in the wrong field.

## References

- `frontend/app/api/auth/login/route.ts`
- `docs/security.md` — "Rate limiting caveat" section
- `.env.example` — `QUEUE_BULL_REDIS_HOST`, `QUEUE_BULL_REDIS_PORT`
