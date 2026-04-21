# Issue 005 — Replace next/font/google with next/font/local for CI compatibility

**Labels:** `infra` `dx` `low-priority`

---

## Context

The CI workflow (`.github/workflows/frontend-ci.yml`) runs `npm run build` on every PR.
`next/font/google` downloads font files from Google's CDN at **build time**.

## Problem

If the CI runner or a Railway build environment has restricted outbound network access,
or if Google's font CDN is temporarily unreachable, the build fails with a network error
that is unrelated to the actual code change being tested.

This makes CI unreliable in air-gapped or restricted environments and causes false
build failures for developers working behind corporate proxies.

The `.github/workflows/frontend-ci.yml` already contains a comment noting this risk:
```yaml
# next/font/google requires outbound network access during build.
# If this step fails in CI with a network error, consider switching to
# next/font/local. See docs/deployment.md for details.
```

## Proposed Fix

1. Identify which fonts are currently loaded via `next/font/google` — check all files
   under `frontend/app/` and `frontend/components/` for `from 'next/font/google'`.
2. Download the font files and place them in `frontend/public/fonts/`.
3. Replace the `next/font/google` import with `next/font/local`, pointing to the local files.
4. Verify the UI is visually unchanged in dev (`npm run dev`).
5. Confirm `npm run build` no longer makes outbound font requests.

## Acceptance Criteria

- [ ] No `next/font/google` imports remain in the codebase.
- [ ] Font files are committed to `frontend/public/fonts/` (they are static assets, not secrets).
- [ ] `npm run build` succeeds without outbound network access.
- [ ] Visual appearance is unchanged — screenshot comparison in PR description.
- [ ] CI build passes without the network-access comment caveat.
- [ ] Remove the caveat comment from `.github/workflows/frontend-ci.yml` once resolved.

## Risk Notes

- This is a pure infrastructure change — no product logic is affected.
- Font licenses: verify the chosen fonts allow self-hosting (Google Fonts are generally
  OFL or Apache 2.0, both allow self-hosting).
- Keep font file sizes reasonable — large font families with many weights can bloat
  the repository. Include only the weights actually used.

## References

- `.github/workflows/frontend-ci.yml` — caveat comment
- `docs/deployment.md` — "Build notes" section
- Next.js docs: https://nextjs.org/docs/app/building-your-application/optimizing/fonts#local-fonts
