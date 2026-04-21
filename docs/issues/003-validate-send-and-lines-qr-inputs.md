# Issue 003 — Harden input validation on /api/send and /api/lines/qr

**Labels:** `security` `api` `medium-priority`

---

## Context

Two API routes call external services using values derived from the request body:

- `frontend/app/api/send/route.ts` — sends `phones[]` and `message` to an n8n webhook URL
  configured in `N8N_URL` (env var, server-side only).
- `frontend/app/api/lines/qr/route.ts` — calls the Evolution API using an `instance` name
  from the request body.

## Problem

### `/api/send`

Current validation only checks `phones?.length` and `message` truthy.
Missing checks:
- Maximum phone count per request (no upper bound — a single request could enqueue thousands).
- Phone format (accepts arbitrary strings passed to n8n).
- `media_url` is passed to n8n without any URL format validation.
- `campaign_id`, if provided, is not validated as a UUID before being interpolated into the
  log batch query (even with parameterized SQL, a malformed UUID causes a Postgres cast error
  that currently surfaces as a 500 with a raw DB error message).

### `/api/lines/qr`

Current validation:
- `instance` (POST body) — used to call Evolution API; not validated against a whitelist or
  pattern. A crafted instance name with path traversal characters (`../`) could manipulate
  the Evolution API URL path.

## Proposed Fixes

**`/api/send`**
- Validate `phones` is an array of strings, each matching `/^\d{7,15}$/` (E.164 digits only).
- Cap `phones.length` at a reasonable maximum (e.g. 500 per request).
- Validate `campaign_id` is a valid UUID if present (use a simple regex or `uuid` package).
- Validate `media_url` is an absolute HTTPS URL if present.

**`/api/lines/qr`**
- Validate `instance` matches `/^[\w\-]{1,64}$/` — alphanumeric, hyphens, underscores only.
- Return `400` immediately on invalid `instance` rather than forwarding to Evolution.

## Acceptance Criteria

- [ ] `/api/send` rejects oversized `phones` arrays with `400`.
- [ ] `/api/send` rejects non-numeric phone strings with `400`.
- [ ] `/api/send` rejects malformed `campaign_id` with `400` (no raw DB error exposed).
- [ ] `/api/lines/qr` rejects `instance` values with path-traversal characters with `400`.
- [ ] No changes to the happy path — existing valid requests continue to work.
- [ ] `npx tsc --noEmit` and `npm run build` pass.

## Risk Notes

- Phone format validation should match what Evolution API and n8n already expect —
  verify against live instance before tightening the regex.
- Do not reject existing valid phone formats used in production campaigns.

## References

- `frontend/app/api/send/route.ts`
- `frontend/app/api/lines/qr/route.ts`
- `docs/security.md` — "API route security rules"
