'use strict'

// Local-only integration. The QA runner additionally pins the disposable data
// directory and Unix socket. No credentials, provider calls or production data.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { Client } = require('pg')
const { assertLocalTestUrl } = require('../helpers/local-db-guard')
const { SyncRunStore } = require('../../src/casino-connectors/sync/SyncRunStore')

const TEST_URL = process.env.TEST_DATABASE_URL
const suite = TEST_URL ? describe : describe.skip
const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/125_casino_sync_monitoring.sql'), 'utf8')
const preflight = fs.readFileSync(path.join(__dirname, '../../db/manual/125_preflight_readonly.sql'), 'utf8')
const bases = ['025_casino_players.sql', '028_casino_transactions.sql', '031_casino_transactions_timestamp.sql', '123_casino_players_platform.sql']
const tables = ['casino_sync_runs', 'casino_sync_agent_ranges', 'casino_sync_cursors']
const roles = ['anon', 'authenticated']

suite('migration 125 — populated data and effective RLS (local PostgreSQL)', () => {
  jest.setTimeout(30_000)
  let admin, db, schema
  const createdRoles = []

  beforeAll(async () => {
    assertLocalTestUrl(TEST_URL)
    admin = new Client({ connectionString: TEST_URL })
    await admin.connect()
    for (const role of roles) {
      const { rows } = await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role])
      if (!rows.length) {
        await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
        createdRoles.push(role)
      } else {
        expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
      }
    }
  })

  beforeEach(async () => {
    schema = `casino_migration_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Client({ connectionString: TEST_URL, options: `-c search_path=${schema}` })
    await db.connect()
    for (const name of bases) {
      await db.query(fs.readFileSync(path.join(__dirname, '../../db/migrations', name), 'utf8'))
    }
    // Simulate Supabase's defaults on this temporary schema only.
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated`)
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated`)
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO anon, authenticated`)
  })

  afterEach(async () => {
    if (db) {
      await db.query('ROLLBACK')
      await db.query('RESET ROLE')
      await db.end()
      db = null
    }
    if (schema && admin) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  afterAll(async () => {
    if (admin) {
      try { for (const role of createdRoles) await admin.query(`DROP ROLE ${role}`) }
      finally { await admin.end() }
    }
  })

  async function seedLegacy(n = 10000) {
    await db.query(`INSERT INTO casino_players (username, agente, total_cargas, seg_monto, seg_actividad)
      SELECT 'player_' || g, 'original_agent', 90000, 'vip', 'inactivo'
      FROM generate_series(1, 1000) g`)
    await db.query(`INSERT INTO casino_transactions (id_rec, fecha, agente, username, tipo, monto)
      SELECT g, DATE '2026-01-01' + (g % 180), 'agent_' || g,
             'player_' || (1 + g % 1000), CASE WHEN g % 3 = 0 THEN 'retiro' ELSE 'carga' END, 100 + g
      FROM generate_series(1, $1::int) g`, [n])
  }

  async function fingerprint(table, omitPlatform = false) {
    const row = omitPlatform ? "to_jsonb(t) - 'platform'" : 'to_jsonb(t)'
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n,
      md5(COALESCE(string_agg((${row})::text, ',' ORDER BY id), '')) AS digest FROM ${table} t`)
    return rows[0]
  }

  async function seedMonitoring() {
    const runId = randomUUID()
    const store = new SyncRunStore(db, { instanceId: 'synthetic-qa' })
    await store.startRun({ runId, platform: 'zeus', mode: 'range', triggeredBy: 'cli',
      requestedDesde: '2026-01-01', requestedHasta: '2026-01-02', requestedAgents: ['betcoin'] })
    await store.recordRange(db, { runId, platform: 'zeus', agente: 'betcoin',
      desde: '2026-01-01', hasta: '2026-01-02', status: 'success', coverage: 'limited',
      txFetched: 10, txNormalized: 5, txInserted: 5, txInvalid: 2, txExcluded: 3 })
    await db.query(`INSERT INTO casino_sync_cursors
      (platform, agente, covered_from, covered_through, last_run_id)
      VALUES ('zeus', 'betcoin', '2026-01-01', '2026-01-02', $1)`, [runId])
    return runId
  }

  it('migrates 10,000 historical rows twice without changing legacy rows, players or monitoring data', async () => {
    await seedLegacy()
    const beforeTx = await fingerprint('casino_transactions', true)
    const beforePlayers = await fingerprint('casino_players')
    const started = performance.now()
    await db.query(migration)
    expect(await fingerprint('casino_transactions', true)).toEqual(beforeTx)
    expect(await fingerprint('casino_players')).toEqual(beforePlayers)
    expect((await db.query('SELECT COUNT(*)::int AS n FROM casino_transactions WHERE platform IS NULL')).rows[0].n).toBe(10000)
    await seedMonitoring()
    const monitoringBefore = []
    for (const table of tables) monitoringBefore.push((await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows)
    await db.query(migration)
    expect(await fingerprint('casino_transactions', true)).toEqual(beforeTx)
    expect(await fingerprint('casino_players')).toEqual(beforePlayers)
    for (const [i, table] of tables.entries()) {
      expect((await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows).toEqual(monitoringBefore[i])
    }
    console.log(`Synthetic migration sample: 10,000 transactions, 1,000 players, two applications in ${Math.round(performance.now() - started)} ms (not a production estimate)`)
  })

  it('rolls back the whole migration when a new case-insensitive unique index finds a collision', async () => {
    await db.query('ALTER TABLE casino_transactions ADD COLUMN platform text')
    await db.query(`INSERT INTO casino_transactions (fecha, agente, username, tipo, monto, platform)
      VALUES ('2026-01-01','betcoin','CasePlayer','carga',100,'zeus'),
             ('2026-01-01','betcoin','caseplayer','carga',100,'zeus')`)
    const before = await fingerprint('casino_transactions')
    await expect(db.query(migration)).rejects.toMatchObject({ code: '23505' })
    await db.query('ROLLBACK')
    expect(await fingerprint('casino_transactions')).toEqual(before)
    const { rows } = await db.query(`SELECT to_regclass('idx_casino_transactions_id_rec') IS NOT NULL AS old_index,
      to_regclass('casino_sync_runs') IS NULL AS no_new_table,
      to_regclass('idx_casino_transactions_platform_id_rec') IS NULL AS no_partial_index`)
    expect(rows[0]).toEqual({ old_index: true, no_new_table: true, no_partial_index: true })
  })

  it('revokes effective table and sequence privileges inherited from schema defaults', async () => {
    await db.query(migration)
    await seedMonitoring()
    for (const role of roles) {
      for (const table of tables) {
        const { rows } = await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, `${schema}.${table}`, 'SELECT,INSERT,UPDATE,DELETE'])
        expect(rows[0].allowed).toBe(false)
      }
      expect((await db.query('SELECT has_sequence_privilege($1,$2,$3) AS allowed',
        [role, `${schema}.casino_sync_agent_ranges_id_seq`, 'USAGE,SELECT,UPDATE'])).rows[0].allowed).toBe(false)
      await db.query(`SET ROLE ${role}`)
      try {
        for (const table of tables) await expect(db.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
        await expect(db.query("SELECT nextval('casino_sync_agent_ranges_id_seq')")).rejects.toMatchObject({ code: '42501' })
      } finally { await db.query('RESET ROLE') }
    }
  })

  it('RLS still hides rows and rejects writes if table grants are accidentally restored', async () => {
    await db.query(migration)
    const runId = await seedMonitoring()
    // Intentionally grant permissions only in the disposable schema to exercise
    // RLS independently of REVOKE. RLS remains enabled with no policies.
    for (const role of roles) {
      await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(',')} TO ${role}`)
      await db.query(`SET ROLE ${role}`)
      try {
        for (const table of tables) expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([])
        for (const table of tables) {
          expect((await db.query(`UPDATE ${table} SET platform = 'bet30'`)).rowCount).toBe(0)
          expect((await db.query(`DELETE FROM ${table}`)).rowCount).toBe(0)
        }
        await expect(db.query(`INSERT INTO casino_sync_runs (run_id,platform,mode,status)
          VALUES ($1,'zeus','auto','running')`, [randomUUID()])).rejects.toMatchObject({ code: '42501' })
        await expect(db.query(`INSERT INTO casino_sync_agent_ranges (id,run_id,platform,agente,status)
          VALUES (999,$1,'zeus','royal','success')`, [runId])).rejects.toMatchObject({ code: '42501' })
        await expect(db.query(`INSERT INTO casino_sync_cursors (platform,agente,covered_from,covered_through)
          VALUES ('zeus','royal','2026-01-01','2026-01-02')`)).rejects.toMatchObject({ code: '42501' })
      } finally { await db.query('RESET ROLE') }
    }
    for (const table of tables) expect((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1)
  })

  it('persists nonzero invalid and excluded counters without changing limited coverage', async () => {
    await db.query(migration)
    await seedMonitoring()
    expect((await db.query('SELECT tx_invalid,tx_excluded,tx_fetched,tx_normalized,coverage FROM casino_sync_agent_ranges')).rows)
      .toEqual([{ tx_invalid: 2, tx_excluded: 3, tx_fetched: 10, tx_normalized: 5, coverage: 'limited' }])
  })

  it('uses the lower(agent) legacy index for a selective lookup on 10,000 rows', async () => {
    await seedLegacy()
    await db.query(migration)
    await db.query('ANALYZE casino_transactions')
    const { rows } = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT COUNT(*) FROM casino_transactions WHERE platform IS NULL
      AND LOWER(agente) = LOWER('AGENT_4321') AND fecha BETWEEN '2026-01-01' AND '2026-12-31'`)
    const plan = rows[0]['QUERY PLAN']
    expect(JSON.stringify(plan)).toContain('idx_casino_transactions_unclassified')
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM casino_transactions
      WHERE platform IS NULL AND LOWER(agente)=LOWER('AGENT_4321')`)).rows[0].n).toBe(1)
  })

  it('aborts on a concurrent writer with a bounded lock timeout and preserves old schema/data', async () => {
    await seedLegacy(20)
    const before = await fingerprint('casino_transactions')
    const writer = new Client({ connectionString: TEST_URL, options: `-c search_path=${schema}` })
    await writer.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('LOCK TABLE casino_transactions IN ROW EXCLUSIVE MODE')
      await db.query("SET lock_timeout='150ms'")
      await expect(db.query(migration)).rejects.toMatchObject({ code: '55P03' })
      await db.query('ROLLBACK')
      await db.query('RESET lock_timeout')
      expect(await fingerprint('casino_transactions')).toEqual(before)
      expect((await db.query("SELECT to_regclass('casino_sync_runs') IS NULL AS absent")).rows[0].absent).toBe(true)
    } finally {
      await writer.query('ROLLBACK')
      await writer.end()
    }
  })

  it('preflight inspects the resolved schema and detects NULL aggregates without writing', async () => {
    const other = `${schema}_other`
    await admin.query(`CREATE SCHEMA ${other}`)
    try {
      await admin.query(`CREATE TABLE ${other}.casino_transactions (id int, platform text)`)
      await admin.query(`CREATE INDEX other_only_index ON ${other}.casino_transactions(id)`)
      await db.query("INSERT INTO casino_players (username, total_cargas, total_retiros) VALUES ('null_totals',NULL,NULL)")
      await db.query(`INSERT INTO casino_transactions (id_rec,fecha,agente,username,tipo,monto)
        VALUES (1,'2026-01-01','betcoin','null_totals','carga',10)`)
      const before = await fingerprint('casino_players')
      const result = await db.query(preflight)
      expect(result.find(r => r.rows[0]?.tx_platform_existe !== undefined).rows[0].tx_platform_existe).toBe(false)
      const indices = result.find(r => r.rows[0]?.indexname).rows
      expect(indices.map(i => i.indexname)).not.toContain('other_only_index')
      const drift = result.find(r => r.rows[0]?.jugadores_comparados !== undefined).rows[0]
      expect(drift.con_diferencia_cargas).toBe('1')
      expect(drift.con_diferencia_retiros).toBe('1')
      expect(await fingerprint('casino_players')).toEqual(before)
    } finally { await admin.query(`DROP SCHEMA ${other} CASCADE`) }
  })

  it('preflight reports real backfill collisions against classified rows, not cross-platform false positives', async () => {
    await db.query(migration)
    await db.query(`INSERT INTO casino_transactions (id_rec,fecha,agente,username,tipo,monto,platform) VALUES
      (50,'2026-01-01','betcoin','id_candidate','carga',100,NULL),
      (50,'2026-01-01','royal','id_existing','carga',100,'zeus'),
      (50,'2026-01-01','btcuno','id_other_platform','carga',100,'bet30'),
      (NULL,'2026-01-01','betcoin','Foo','carga',20,NULL),
      (NULL,'2026-01-01','betcoin','foo','carga',20,NULL),
      (NULL,'2026-01-01','betcoin','FOO','carga',20,'zeus'),
      (NULL,'2026-01-01','betcoin','fOo','carga',20,'bet30'),
      (NULL,'2026-01-01','bigwin','Foo','carga',20,NULL),
      (NULL,'2026-01-01','bigwin','foo','carga',20,NULL),
      (NULL,'2026-01-01','unknown','Foo','carga',20,NULL),
      (NULL,'2026-01-01','unknown','foo','carga',20,NULL)`)
    const before = await fingerprint('casino_transactions')
    const result = await db.query(preflight)
    expect(result.find(r => r.rows[0]?.tx_platform_existe !== undefined).rows[0].tx_platform_existe).toBe(true)
    const withId = result.find(r => r.rows[0]?.plataforma_destino && r.rows[0]?.id_rec !== undefined).rows
    expect(withId).toEqual([{ plataforma_destino: 'zeus', id_rec: '50', filas: '2', candidatos: '1' }])
    const withoutId = result.find(r => r.rows[0]?.plataforma_destino && r.rows[0]?.username_lower).rows
    expect(withoutId).toHaveLength(1)
    expect(withoutId[0]).toMatchObject({ plataforma_destino: 'zeus', agente: 'betcoin', username_lower: 'foo', filas: '3', candidatos: '2' })
    const candidates = result.find(r => r.rows[0]?.clasificacion).rows
    expect(candidates.find(r => r.agente === 'betcoin').filas).toBe('3')
    expect(candidates.some(r => r.agente === 'royal' || r.agente === 'btcuno')).toBe(false)
    expect(await fingerprint('casino_transactions')).toEqual(before)
  })

  it('preflight read-only transaction refuses an injected accidental write', async () => {
    // Injection exists only in test memory to verify the real READ ONLY gate.
    const withWrite = preflight.replace(/ROLLBACK;\s*$/, "INSERT INTO casino_players (username) VALUES ('must_not_exist');\nROLLBACK;")
    await expect(db.query(withWrite)).rejects.toMatchObject({ code: '25006' })
    await db.query('ROLLBACK')
    expect((await db.query("SELECT COUNT(*)::int AS n FROM casino_players WHERE username='must_not_exist'")).rows[0].n).toBe(0)
  })
})
