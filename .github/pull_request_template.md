## Summary

<!-- What does this PR do and why? -->

## Type of change

- [ ] New feature
- [ ] Bug fix
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Chore (deps, config, CI)

## Testing

<!-- How was this tested? Local dev? Staging? Manual steps? -->

## DB migrations

- [ ] No migrations
- [ ] Migration added — tested on dev DB
- [ ] Migration tested on staging

## Environment variables

- [ ] No new vars
- [ ] New vars added to `.env.example` and documented in `docs/environment.md`

## Screenshots

<!-- Attach for any UI changes -->

## Risk checklist

- [ ] Touches auth (`middleware.ts`, `api/auth/`)
- [ ] Touches campaigns processor (`api/campaigns/[id]/send/`)
- [ ] Touches Evolution webhook (`api/webhook/evolution/`)
- [ ] Touches DB schema or migrations
- [ ] Handles PII / phone numbers
