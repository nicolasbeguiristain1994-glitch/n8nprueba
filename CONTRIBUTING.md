# Contributing

## Branch naming

```
feature/add-campaign-scheduling
fix/conversation-scroll-bug
chore/update-dependencies
docs/add-database-runbook
refactor/contacts-import-query
```

Branch off `main`. No direct pushes to `main`.

---

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add bulk contact import via CSV
fix: release processor lock on campaign crash
chore: update next to 16.2.3
docs: add database migration guide
refactor: replace N+1 import loop with bulk upsert
```

Keep the subject line under 72 characters.
Add a body if the change is non-obvious.

---

## Pull request checklist

Before requesting review, confirm:

- [ ] Scope is clear — one concern per PR
- [ ] No secrets, API keys, or `.env` files in the diff
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` passes (or failure is documented with reason)
- [ ] New DB migrations are documented and tested on a dev DB
- [ ] Screenshots or recordings attached for any UI changes
- [ ] Risk noted for changes touching the campaigns processor, webhook, or auth

---

## Review expectations

- At least **one approval** before merge.
- The author resolves or responds to all review comments before merging.
- Reviewer focuses on: security, data integrity, error handling, performance, UX regressions.
- For changes to the campaign processor or Evolution webhook: two reviewers preferred.

---

## Code review focus areas

| Area | What to check |
|---|---|
| Security | Parameterized SQL, input validation, no secrets in logs |
| Data integrity | Lock handling, idempotency, FK constraints, UPSERT correctness |
| Error handling | All `await` calls caught, locks released in `finally` |
| Performance | No N+1 queries, indexes exist for new WHERE clauses |
| UX regressions | Modal state resets, error messages shown, loading states correct |

---

## What not to do

- Don't push directly to `main`.
- Don't bypass `--no-verify` on commits unless you understand what the hook is checking.
- Don't add `NEXT_PUBLIC_` prefix to secrets.
- Don't leave `console.log` calls with phone numbers or tokens.
- Don't open PRs that mix unrelated changes.
