# Security utilities — quick reference

## `schema.ts` — Input validation

### `parseBody(schema, data)`

Validates arbitrary `data` against a Zod schema. Returns a discriminated union — no exceptions thrown.

```ts
import { parseBody, handleValidationError, CreateUserSchema } from '@/lib/schema'

export async function POST(req: Request) {
  const body   = await req.json().catch(() => null)
  const parsed = parseBody(CreateUserSchema, body)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'users')

  // parsed.data is fully typed as CreateUserInput
  const { email, role, sectors } = parsed.data
}
```

### `handleValidationError(req, error, resource)`

Builds a consistent `400` response and fires a non-blocking audit event so that repeated malformed requests are traceable in `rbac_audit_log`.

```ts
if (!parsed.ok) return handleValidationError(req, parsed.error, 'campaigns')
```

### Adding a new schema

1. Define it in `schema.ts` next to the related schemas.
2. Export the `z.infer<>` type alias alongside it.
3. Use `parseBody` in the route handler — no manual `if/else` chains.

```ts
export const CreateCampaignSchema = z.object({
  name:    z.string().min(1).max(120).trim(),
  message: z.string().min(1).max(4096),
  list_id: z.string().uuid(),
})
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>
```

---

## `rate-limit.ts` — In-memory rate limiter

### `RateLimiter` class

| Method | Description |
|---|---|
| `isBlocked(key)` | Returns `true` if the key has exceeded the limit |
| `increment(key)` | Records one hit (call on every failed attempt) |
| `reset(key)` | Clears the counter (call on success) |
| `prune()` | Removes expired entries (call periodically on busy limiters) |

```ts
import { RateLimiter } from '@/lib/rate-limit'

const apiLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 60_000 })

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for') ?? 'unknown'
  if (apiLimiter.isBlocked(ip)) {
    return Response.json({ error: 'Too many requests' }, { status: 429 })
  }
  // ...on failure:
  apiLimiter.increment(ip)
  // ...on success:
  apiLimiter.reset(ip)
}
```

**Known limitation:** state resets on server restart and is not shared across multiple instances. Phase 2 will replace the backing store with Redis.

### `loginRateLimiter` (pre-configured)

A shared instance configured for the login endpoint (10 failed attempts / 15 min). Import directly instead of creating a new one.

---

## `middleware.ts` — Auth gate + security headers

All routes are protected by default. To add a new unprotected route (webhook, internal cron, etc.) append its prefix to `UNPROTECTED_API_PREFIXES` in `middleware.ts`.

**Security headers applied to every response:**

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, mic, geolocation disabled |
| `Content-Security-Policy-Report-Only` | permissive (Phase 1 — collect violations) |

**Phase 2 action:** tighten CSP directives and switch from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
