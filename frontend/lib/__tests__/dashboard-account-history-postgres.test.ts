// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn().mockResolvedValue(undefined) }))
import { query } from '@/lib/db'
import { GET } from '@/app/api/dashboard/casino/route'

describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS !== '1')('complete dashboard account history', () => {
  let db: Client
  let connectionString: string
  const schema = 'dashboard_history_' + randomUUID().replaceAll('-', '')
  const sql = (q: string, p?: unknown[]) => db.query(q, p)
  const account = async (name = 'shared', platform = 'zeus') =>
    (await sql('SELECT * FROM casino_dashboard_players WHERE platform=$1 AND username_lower=$2', [platform, name])).rows[0]
  const tx = async (id: number, name: string, amount: number, day: string, extra: { platform?: string | null; kind?: string; details?: string; agent?: string; imported?: boolean; instant?: string } = {}) => {
    await sql(`INSERT INTO casino_transactions(id,id_rec,platform,username,agente,tipo,monto,fecha,fecha_hora_utc,raw_detalles,source_id)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, extra.platform === undefined ? 'zeus' : extra.platform, name, extra.agent ?? 'royal', extra.kind ?? 'carga', amount, day, extra.instant ?? null, extra.details ?? '', extra.imported ? 'file:' + id : null])
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local database required')
    connectionString = url.toString()
    db = new Client({ connectionString, ssl: false }); await db.connect()
    await sql(`CREATE SCHEMA ${schema}; SET search_path=${schema},pg_catalog`)
    await sql(`CREATE TABLE casino_transactions(id bigint PRIMARY KEY,id_rec bigint,platform text,username varchar(100),agente text,tipo text,monto numeric,fecha date,fecha_hora_utc timestamptz,raw_detalles text,source_id text);
      CREATE UNIQUE INDEX ON casino_transactions(platform,id_rec); CREATE INDEX ON casino_transactions(lower(username));
      CREATE TABLE casino_financial_source_records(platform text,source_id text,transaction_id bigint,kind text,agente text,username text,monto numeric,fecha date,fecha_hora_utc timestamptz,PRIMARY KEY(platform,source_id));
      CREATE UNIQUE INDEX ON casino_financial_source_records(transaction_id) WHERE transaction_id IS NOT NULL`)
    const migration = fs.readFileSync(path.resolve(process.cwd(), '../db/migrations/139_dashboard_account_history.sql'), 'utf8').replace(/\bpublic\b/g, schema)
    await sql(migration)
    vi.mocked(query).mockImplementation(async (q, p) => (await sql(q, p)).rows)
  })
  beforeEach(async () => { await sql('BEGIN') })
  afterEach(async () => { await sql('ROLLBACK') })
  afterAll(async () => { if (db) { await sql(`DROP SCHEMA ${schema} CASCADE`); await db.end() } })

  it('combines imported and synced history, excludes bonuses and keeps namesakes separate', async () => {
    await tx(1, 'Shared', 600000, '2026-08-01', { imported: true })
    await tx(2, 'shared', 600000, '2026-09-01')
    await tx(3, 'shared', 9000000, '2026-07-01', { details: ' Bono ' })
    await tx(4, 'shared', 200, '2026-09-02', { platform: 'bet30' })
    await tx(5, 'shared', 99999999, '2026-06-01', { platform: null })
    const p = await account()
    expect(p).toMatchObject({ total_cargas: '1200000', cant_cargas: 2, seg_monto: 'vip' })
    expect(p.fecha_primera.toISOString().slice(0, 10)).toBe('2026-08-01')
    expect((await account('shared', 'bet30')).total_cargas).toBe('200')
    expect((await sql('SELECT count(*)::int AS n FROM casino_dashboard_players')).rows[0].n).toBe(2)
  })
  it('follows Argentina dates, and credits first deposits to the original agent', async () => {
    await tx(1, 'moved', 100, '2026-09-02', { instant: '2026-09-02T01:00:00Z', agent: 'Royal' })
    await tx(2, 'moved', 200, '2026-09-05', { agent: 'farabet' })
    const p = await account('moved')
    expect(p.fecha_primera.toISOString().slice(0, 10)).toBe('2026-09-01')
    expect(p).toMatchObject({ agente: 'farabet', first_deposit_agent: 'royal' })
    for (const [agent, first, current] of [['royal', 1, 0], ['farabet', 0, 1]] as const) {
      const response = await GET(new Request(`http://localhost/api/dashboard/casino?platform=zeus&agent=${agent}&from=2026-09-01&to=2026-09-30`))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.summary).toMatchObject({ nuevos_mes: first, total_jugadores: current })
      expect(body.agentes[0].nuevos_mes).toBe(first)
    }
  })
  it('uses current local calendar date for activity, independently of the SQL session timezone', async () => {
    const day = (await sql("SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date-31)::text AS day")).rows[0].day
    await tx(1, 'risk', 700000, day)
    await sql("SET LOCAL TIME ZONE 'Pacific/Kiritimati'")
    expect(await account('risk')).toMatchObject({ seg_monto: 'vip', seg_actividad: 'en_riesgo' })
    await sql("SET LOCAL TIME ZONE 'Pacific/Honolulu'")
    expect(await account('risk')).toMatchObject({ seg_actividad: 'en_riesgo' })
  })
  it('updates amounts, dates, bonus classification and deletes without stale aggregates', async () => {
    await tx(1, 'shared', 100, '2026-08-01')
    await tx(2, 'shared', 200, '2026-09-01')
    await sql("UPDATE casino_transactions SET monto=500,fecha='2026-07-01' WHERE id=2")
    expect(await account()).toMatchObject({ total_cargas: '600', cant_cargas: 2 })
    await sql("UPDATE casino_transactions SET raw_detalles='Bono' WHERE id=2")
    expect(await account()).toMatchObject({ total_cargas: '100', cant_cargas: 1 })
    await sql('DELETE FROM casino_transactions WHERE id=1')
    expect(await account()).toMatchObject({ total_cargas: '0', cant_cargas: 0, fecha_primera: null, seg_actividad: 'perdido' })
    await sql('DELETE FROM casino_transactions WHERE id=2')
    expect(await account()).toBeUndefined()
  })
  it('refreshes both identities when a transaction changes platform, name or id', async () => {
    await tx(1, 'shared', 100, '2026-09-01')
    await sql("UPDATE casino_transactions SET platform='bet30',username='renamed',id=2 WHERE id=1")
    expect(await account()).toBeUndefined()
    expect(await account('renamed', 'bet30')).toMatchObject({ total_cargas: '100' })
  })
  it('tracks original provider amounts on insert, update and delete, without counting external bonuses', async () => {
    await tx(1, 'precision', 100, '2026-09-01', { platform: 'argenbet' })
    await sql("INSERT INTO casino_financial_source_records(platform,source_id,transaction_id,kind,monto) VALUES('argenbet','original',1,'importe_original',100.1234)")
    expect((await account('precision', 'argenbet')).total_cargas).toBe('100.1234')
    await sql("UPDATE casino_financial_source_records SET monto=101.2345 WHERE source_id='original'")
    expect((await account('precision', 'argenbet')).total_cargas).toBe('101.2345')
    await sql("INSERT INTO casino_financial_source_records(platform,source_id,kind,monto) VALUES('argenbet','bonus','bono',10000000)")
    expect((await account('precision', 'argenbet')).cant_cargas).toBe(1)
    await sql("DELETE FROM casino_financial_source_records WHERE source_id='original'")
    expect((await account('precision', 'argenbet')).total_cargas).toBe('100')
  })
  it('replaying an identified operation and rebuilding repeatedly does not duplicate it', async () => {
    await tx(1, 'shared', 600000, '2026-09-01')
    await sql('INSERT INTO casino_transactions SELECT * FROM casino_transactions ON CONFLICT DO NOTHING')
    await sql("SELECT refresh_casino_dashboard_accounts('zeus',ARRAY['shared','Shared'])")
    await sql("SELECT refresh_casino_dashboard_accounts('zeus',ARRAY['shared'])")
    expect(await account()).toMatchObject({ total_cargas: '600000', cant_cargas: 1, seg_monto: 'vip' })
    const before = (await sql('SELECT refreshed_at FROM casino_dashboard_account_totals')).rows[0].refreshed_at
    await sql("UPDATE casino_transactions SET source_id='new-provenance'")
    expect((await sql('SELECT refreshed_at FROM casino_dashboard_account_totals')).rows[0].refreshed_at).toEqual(before)
  })
  it('serializes concurrent account changes without losing either deposit', async () => {
    const a = new Client({ connectionString, ssl: false }), b = new Client({ connectionString, ssl: false })
    try {
      await a.connect(); await b.connect()
      await a.query(`SET search_path=${schema},pg_catalog; BEGIN`)
      await b.query(`SET search_path=${schema},pg_catalog; BEGIN`)
      await a.query("INSERT INTO casino_transactions(id,id_rec,platform,username,agente,tipo,monto,fecha) VALUES(100,100,'zeus','concurrent','royal','carga',10,'2026-09-01')")
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = b.query("INSERT INTO casino_transactions(id,id_rec,platform,username,agente,tipo,monto,fecha) VALUES(101,101,'zeus','concurrent','royal','carga',20,'2026-09-02')")
      let waiting = false
      for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
        waiting = (await sql("SELECT wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting === true
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      await a.query('COMMIT'); await pending; await b.query('COMMIT')
      expect(await account('concurrent')).toMatchObject({ total_cargas: '30', cant_cargas: 2 })
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK')
      await a.query("DELETE FROM casino_transactions WHERE username='concurrent'")
      await a.end(); await b.end()
    }
  })
})
