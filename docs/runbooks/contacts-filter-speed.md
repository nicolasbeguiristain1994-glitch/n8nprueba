# Contact filtering performance

The interactive contacts page requests `history=deferred`. The API resolves the
same authorized audience and exact count, reading the page and count concurrently.
The browser renders those rows immediately and enriches up to 50 visible IDs with
`GET /api/contacts/history`. That endpoint checks fresh permissions and contact
visibility, then reads broadcast and movement history concurrently. Broadcasts
remain scoped to phone plus agent. Movement values already resolved by an
inactivity audience are reused, so only broadcast history is requested afterward.

Pending history is labelled “Cargando…”; a failed lookup is “No disponible”, never
“Sin movimientos registrados” or “Sin difusión”. Filter changes, refreshes and
unmounts abort requests and invalidate their sequence number. Late enrichment
cannot overwrite the next search. Downloads and existing API callers keep their
complete response, and select-all continues to use the same audience.

The broad last-movement query aggregates only the relevant movement dates without
sorting all transactions. Imported identity precedence is resolved separately with
`DISTINCT ON (platform, lower(username))` over imported rows, keeping the existing
timestamp/ID ordering, including null ordering. The small and broad account-link
queries retain cross-platform ambiguity and explicit-account precedence. Array
expansion uses `unnest` to avoid inflated row estimates from set-returning functions.

## Verification

- PostgreSQL integration covers identical full/deferred/export results, missing
  and future history, identity ambiguity, imported-agent precedence, and separate
  broadcast histories for two agent accounts sharing a phone.
- UI tests cover rendering before enrichment, late responses after search changes,
  failed history, debouncing, aborts, and explicit refresh.
- Route tests cover permissions, deleted contacts, agent visibility, invalid IDs,
  the 50-ID limit, and private/no-store responses.
- A read-only pre-transition production plan used 2,840,169 ledger rows. Separating
  ordered identity lookup from movement aggregation reduced SQL execution from
  28,132 ms to 9,668 ms and eliminated the 184,568 kB external sort. These are SQL
  measurements, not browser latency guarantees. A concurrent account-schema
  transition interrupted later measurements; those lock timeouts are excluded.

No schema migration or data rewrite is required by this optimization. Roll back
the application to the preceding release **compatible with contact schema v2**;
never roll back to the pre-transition data model.
