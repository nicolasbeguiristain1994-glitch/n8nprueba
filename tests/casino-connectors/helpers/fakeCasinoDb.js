'use strict'

/**
 * Minimal in-memory simulation of the two tables BaseCasinoConnector writes to,
 * plus a pg-`Pool`-shaped adapter (`.query()` / `.connect()`), used to verify
 * end-to-end idempotency and identity semantics (D1/D2) WITHOUT a real
 * Postgres — which this phase is explicitly not allowed to touch.
 *
 * This is a disclosed simplification, not a substitute for a Postgres
 * integration test:
 *  - It re-implements the SAME aggregation rules the production SQL is
 *    supposed to encode (sum by platform+username_lower across ALL agentes,
 *    deposit-only fecha_primera/fecha_ultima, last-transaction-wins agente),
 *    derived independently from the spec — not copied from
 *    BaseCasinoConnector.recomputePlayers()'s SQL text — so it can catch a
 *    real divergence between what that SQL says and what it should compute.
 *  - It does NOT parse/execute arbitrary SQL. It recognizes the exact query
 *    shapes BaseCasinoConnector issues (transaction control statements, the
 *    pre-insert identity-collision SELECT added in fase 2, the
 *    casino_transactions batch insert, and the casino_players recompute
 *    insert) by keyword/column-count, and reproduces their real-world dedup /
 *    upsert-by-assignment effect against its own in-memory tables. The
 *    collision SELECT only ever answers "what's already there" — whether
 *    that counts as a collision is decided by the real
 *    BaseCasinoConnector._assertNoIdentityCollisions() code under test.
 *  - Money is kept as JS numbers with 2-decimal fixtures in tests (values
 *    small enough that float error is not a concern here); it does not
 *    validate NUMERIC precision at scale — that requires a real Postgres run.
 */
function createFakeCasinoDb() {
  const transactions = [] // { id, id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform }
  const players = new Map() // key: `${platform}:${lower(username)}` -> row
  let nextId = 1

  // Returns true only for a genuine INSERT — mirrors the production SQL's
  // `RETURNING (xmax = 0) AS inserted` (fase 2 fix): a backfill-only UPDATE
  // (e.g. filling in a previously-NULL fecha_hora_utc/source_id on a Zeus/
  // Bet30 replay) must count as 0, never as "inserted".
  function insertTransactionRow(row) {
    const dupe = transactions.find(t => {
      if (t.platform !== row.platform) return false
      if (row.id_rec != null) return t.id_rec === row.id_rec
      return (
        t.id_rec == null &&
        t.fecha === row.fecha &&
        t.username.toLowerCase() === row.username.toLowerCase() &&
        t.tipo === row.tipo &&
        String(t.monto) === String(row.monto) &&
        t.agente === row.agente
      )
    })
    if (dupe) {
      if (dupe.fecha_hora_utc == null && row.fecha_hora_utc != null) dupe.fecha_hora_utc = row.fecha_hora_utc
      if (dupe.source_id == null && row.source_id != null) dupe.source_id = row.source_id
      return false
    }
    transactions.push({ id: nextId++, ...row })
    return true
  }

  function sortKey(t) {
    return t.fecha_hora_utc || `${t.fecha}T00:00:00.000Z`
  }

  function recomputePlayers(platform, usernamesLower) {
    const wanted = new Set(usernamesLower)
    const byUser = new Map()

    for (const t of transactions) {
      if (t.platform !== platform) continue
      if (t.username === t.agente) continue
      const lower = t.username.toLowerCase()
      if (!wanted.has(lower)) continue
      if (!byUser.has(lower)) byUser.set(lower, [])
      byUser.get(lower).push(t)
    }

    let count = 0
    for (const [lower, rows] of byUser) {
      const sorted = [...rows].sort((a, b) => {
        const ka = sortKey(a), kb = sortKey(b)
        if (ka !== kb) return ka < kb ? 1 : -1 // most recent first
        return b.id - a.id
      })
      const username = sorted[0].username
      const agente   = sorted[0].agente
      const cargas   = rows.filter(r => r.tipo === 'carga')
      const retiros  = rows.filter(r => r.tipo === 'retiro')

      players.set(`${platform}:${lower}`, {
        username,
        agente,
        platform,
        // 2-decimal precision, matching casino_players.total_cargas/total_retiros
        // NUMERIC(20,2) (migration 127) — cents must survive the recompute.
        total_cargas:  Number(cargas.reduce((s, r) => s + Number(r.monto), 0).toFixed(2)),
        total_retiros: Number(retiros.reduce((s, r) => s + Number(r.monto), 0).toFixed(2)),
        cant_cargas:   cargas.length,
        cant_retiros:  retiros.length,
        fecha_primera: cargas.length ? cargas.map(r => r.fecha).sort()[0] : null,
        fecha_ultima:  cargas.length ? cargas.map(r => r.fecha).sort().slice(-1)[0] : null,
      })
      count++
    }
    return count
  }

  // ── pg-shaped adapter ────────────────────────────────────────────────────

  // Returns one { inserted } row per input row, in order — mirrors the
  // production SQL's `RETURNING (xmax = 0) AS inserted` (fase 2 fix), which
  // BaseCasinoConnector now sums via `result.rows.filter(r => r.inserted)`
  // instead of the old (buggy) `result.rowCount`.
  function parseInsertTransactionParams(sql, params) {
    const hasIdRec = sql.includes('(id_rec, fecha')
    const cols     = hasIdRec ? 10 : 9
    const flags    = []
    for (let i = 0; i < params.length; i += cols) {
      const chunk = params.slice(i, i + cols)
      const row = hasIdRec
        ? { id_rec: chunk[0], fecha: chunk[1], fecha_hora_utc: chunk[2], agente: chunk[3], username: chunk[4], tipo: chunk[5], monto: chunk[6], raw_detalles: chunk[7], platform: chunk[8], source_id: chunk[9] ?? null }
        : { id_rec: null, fecha: chunk[0], fecha_hora_utc: chunk[1], agente: chunk[2], username: chunk[3], tipo: chunk[4], monto: chunk[5], raw_detalles: chunk[6], platform: chunk[7], source_id: chunk[8] ?? null }
      flags.push(insertTransactionRow(row))
    }
    return flags
  }

  // Answers BaseCasinoConnector._assertNoIdentityCollisions()'s pre-insert
  // lookup with whatever this fake DB already holds for those (platform,
  // id_rec) pairs — the actual collision-vs-not decision is made by the real
  // JS under test (BaseCasinoConnector), not reimplemented here. Includes
  // fecha/agente (fase 2 fix) since the real SELECT now does too.
  function selectExistingByIdRec(platform, idRecs) {
    const wanted = new Set(idRecs.map(String))
    return transactions
      .filter(t => t.platform === platform && t.id_rec != null && wanted.has(String(t.id_rec)))
      .map(t => ({ id_rec: String(t.id_rec), fecha: t.fecha, agente: t.agente, source_id: t.source_id ?? null, monto: t.monto, username: t.username, tipo: t.tipo }))
  }

  async function query(sql, params = []) {
    const s = sql.trim()
    if (/^BEGIN/.test(s) || /^COMMIT/.test(s) || /^ROLLBACK/.test(s)) return { rowCount: 0 }
    if (s.includes('pg_advisory_xact_lock')) return { rowCount: 0 } // fase 2: serializes against scripts/import-casino-excel.js's own lock
    if (s.startsWith('SELECT') && s.includes('FROM casino_transactions') && s.includes('id_rec = ANY')) {
      const [platform, idRecs] = params
      return { rows: selectExistingByIdRec(platform, idRecs) }
    }
    if (s.startsWith('INSERT INTO casino_transactions')) {
      const flags = parseInsertTransactionParams(s, params)
      return { rows: flags.map(inserted => ({ inserted })) }
    }
    if (s.startsWith('INSERT INTO casino_players')) {
      const [platform, usernamesLower] = params
      return { rowCount: recomputePlayers(platform, usernamesLower) }
    }
    throw new Error(`fakeCasinoDb: unrecognized query: ${s.slice(0, 60)}...`)
  }

  const client = { query, release: () => {} }
  const pool   = { query, connect: async () => client }

  return { transactions, players, pool }
}

module.exports = { createFakeCasinoDb }
