# Issue Backlog

These files were generated because GitHub CLI was unavailable at time of creation.
Run the commands below once `gh` is installed and authenticated.

---

## Step 1 — Install and authenticate gh

```bash
brew install gh
gh auth login
# choose: GitHub.com → HTTPS → Login with browser
```

---

## Step 2 — Create labels (idempotent — safe to re-run)

```bash
REPO=nicolasbeguiristain1994-glitch/n8nprueba

gh label create database    --repo "$REPO" --color 5319E7 --description "Database schema, migrations, SQL"   || gh label edit database    --repo "$REPO" --color 5319E7 --description "Database schema, migrations, SQL"
gh label create docs        --repo "$REPO" --color 0075CA --description "Documentation"                       || gh label edit docs        --repo "$REPO" --color 0075CA --description "Documentation"
gh label create onboarding  --repo "$REPO" --color C5DEF5 --description "Developer onboarding"               || gh label edit onboarding  --repo "$REPO" --color C5DEF5 --description "Developer onboarding"
gh label create security    --repo "$REPO" --color D73A4A --description "Security hardening"                  || gh label edit security    --repo "$REPO" --color D73A4A --description "Security hardening"
gh label create infra       --repo "$REPO" --color 5319E7 --description "Infrastructure and deployment"       || gh label edit infra       --repo "$REPO" --color 5319E7 --description "Infrastructure and deployment"
gh label create api         --repo "$REPO" --color 1D76DB --description "API routes and validation"           || gh label edit api         --repo "$REPO" --color 1D76DB --description "API routes and validation"
gh label create reliability --repo "$REPO" --color FBCA04 --description "Reliability and durability"          || gh label edit reliability --repo "$REPO" --color FBCA04 --description "Reliability and durability"
gh label create messaging   --repo "$REPO" --color 0E8A16 --description "WhatsApp, n8n, Evolution messaging"  || gh label edit messaging   --repo "$REPO" --color 0E8A16 --description "WhatsApp, n8n, Evolution messaging"
gh label create dx          --repo "$REPO" --color C2E0C6 --description "Developer experience"                || gh label edit dx          --repo "$REPO" --color C2E0C6 --description "Developer experience"
```

---

## Step 3 — Check for existing issues (avoid duplicates)

```bash
gh issue list --repo "$REPO" --limit 100
```

---

## Step 4 — Create issues (run from repo root)

Check the list above first. Skip any issue whose title already exists.

```bash
REPO=nicolasbeguiristain1994-glitch/n8nprueba

gh issue create --repo "$REPO" \
  --title "Reconcile db/schema/init.sql with migrations 001–014" \
  --label "database,docs,onboarding" \
  --body-file docs/issues/001-reconcile-db-schema-init.md

gh issue create --repo "$REPO" \
  --title "Move login rate limiter to a shared store" \
  --label "security,infra" \
  --body-file docs/issues/002-move-login-rate-limit-to-shared-store.md

gh issue create --repo "$REPO" \
  --title "Harden input validation on /api/send and /api/lines/qr" \
  --label "security,api" \
  --body-file docs/issues/003-validate-send-and-lines-qr-inputs.md

gh issue create --repo "$REPO" \
  --title "Enforce dedup_key / idempotency in n8n send workflow" \
  --label "reliability,messaging" \
  --body-file docs/issues/004-enforce-n8n-dedup-key.md

gh issue create --repo "$REPO" \
  --title "Replace next/font/google with next/font/local for CI compatibility" \
  --label "infra,dx" \
  --body-file docs/issues/005-replace-google-font-with-local-font.md
```

---

## Issue index

| # | File | Title | Labels | Priority |
|---|---|---|---|---|
| [001](001-reconcile-db-schema-init.md) | `001-reconcile-db-schema-init.md` | Reconcile db/schema/init.sql with migrations 001–014 | database, docs, onboarding | high |
| [002](002-move-login-rate-limit-to-shared-store.md) | `002-move-login-rate-limit-to-shared-store.md` | Move login rate limiter to a shared store | security, infra | medium |
| [003](003-validate-send-and-lines-qr-inputs.md) | `003-validate-send-and-lines-qr-inputs.md` | Harden input validation on /api/send and /api/lines/qr | security, api | medium |
| [004](004-enforce-n8n-dedup-key.md) | `004-enforce-n8n-dedup-key.md` | Enforce dedup_key / idempotency in n8n send workflow | reliability, messaging | medium |
| [005](005-replace-google-font-with-local-font.md) | `005-replace-google-font-with-local-font.md` | Replace next/font/google with next/font/local for CI compatibility | infra, dx | low |
