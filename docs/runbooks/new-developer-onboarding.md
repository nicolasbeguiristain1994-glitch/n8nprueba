# New Developer Onboarding

## 1. Get access

- [ ] GitHub repo access — ask the team lead
- [ ] Railway staging environment — ask for read access initially
- [ ] Secrets — get `frontend/.env.local` values from the team's secrets manager (1Password / Bitwarden / Doppler / Infisical). **Never ask for secrets over Slack or WhatsApp.**
- [ ] Supabase — staging project access (not production)

## 2. Clone the repo

```bash
git clone https://github.com/nicolasbeguiristain1994-glitch/n8nprueba.git
cd n8nprueba
```

## 3. Configure environment

```bash
cp .env.example frontend/.env.local
# Fill in real values from the secrets manager
```

See [docs/environment.md](../environment.md) for the full variable reference.

## 4. Install dependencies

```bash
cd frontend
npm install
```

## 5. Run the app

```bash
npm run dev
# → http://localhost:3000
```

Log in with the `AUTH_USERNAME` / `AUTH_PASSWORD` values from your `.env.local`.

## 6. Run checks

```bash
npx tsc --noEmit   # must be clean
npm run build      # must succeed
```

If either fails, check that all required env vars are set.

## 7. Create your first branch

```bash
git checkout -b feature/your-first-task
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for branch naming and commit style.

## 8. Explore the codebase

| Where to start | What it covers |
|---|---|
| `frontend/app/` | All pages and API routes |
| `frontend/lib/db.ts` | DB pool — all queries go through here |
| `frontend/middleware.ts` | Auth / session guard |
| `db/migrations/` | Full schema history |
| `docs/` | Architecture decisions and runbooks |
