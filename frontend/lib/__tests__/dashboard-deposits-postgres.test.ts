// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn().mockResolvedValue(undefined) }))
import { query } from '@/lib/db'
import { GET as deposits } from '@/app/api/dashboard/casino/deposits/route'
import { GET as overview } from '@/app/api/dashboard/casino/overview/route'
import { GET as caja } from '@/app/api/dashboard/caja/route'
import type { DepositAnalytics } from '@/lib/dashboard-deposits'

const req = (q = '') => new Request(`http://localhost/?from=2026-09-01&to=2026-09-30&platform=consolidado&${q}`)
describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS !== '1')('deposit graphs, PostgreSQL', () => {
  let c: Client
  let connected = false
  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Local only')
    c = new Client({ connectionString: u.toString(), ssl: false }); await c.connect(); connected = true; await c.query('BEGIN')
    await c.query(`CREATE TEMP TABLE casino_financial_source_records(platform text,source_id text,kind text,transaction_id bigint,agente text,username text,monto numeric,fecha date,fecha_hora_utc timestamptz) ON COMMIT DROP`)
    await c.query(`CREATE TEMP TABLE casino_transactions(id bigint,id_rec bigint,platform text,agente text,username text,tipo text,monto numeric(20,2),fecha date,fecha_hora_utc timestamptz,raw_detalles text) ON COMMIT DROP`)
    // UTC Sept 1 is still August in Argentina; UTC Oct 1 is still September.
    // Same raw name on an unexpected platform must not become a royal alias.
    await c.query(`INSERT INTO casino_transactions(id,platform,agente,username,tipo,monto,fecha,fecha_hora_utc) VALUES
      (1,'zeus','royal','same','carga',10.01,'2026-09-01','2026-09-01T03:00:00Z'),
      (2,'bet30','zeusroyal','same','carga',20.02,'2026-09-07',NULL),
      (3,'ganamos','adminroyal','same','carga',30.03,'2026-09-30','2026-10-01T02:59:59Z'),
      (4,'argenbet','adminroyal','same','carga',40.04,'2026-09-07','2026-09-07T15:20:00Z'),
      (5,'zeus','royal','same','carga',999,'2026-09-01','2026-09-01T02:59:59Z'),
      (6,'zeus','royal','same','retiro',50,'2026-09-07',NULL),
      (7,NULL,'royal','same','carga',888,'2026-09-07',NULL),
      (8,'bet30','adminroyal','same','carga',123,'2026-09-07',NULL),
      (9,'zeus','bigwin','same','carga',3.50,'2026-09-07',NULL),
      (10,'bet30','bigwin','same','carga',4.50,'2026-09-07',NULL),
      (11,'zeus','royal','same','carga',7.07,'2026-08-07',NULL)`)
    vi.mocked(query).mockImplementation(async (sql, params) => (await c.query(sql, params)).rows)
  })
  afterAll(async () => { if (connected) { await c.query('ROLLBACK'); await c.end() } })
  it('royal maps by platform, counts deposits only, exact shares use amounts', async () => {
    const res = await deposits(req('agent=royal')); expect(res.status).toBe(200)
    const b: DepositAnalytics = await res.json()
    expect(b.total).toEqual({ count: 4, amount: '100.10' })
    expect(b.platforms.map(p => p.percentage)).toEqual(['10.00','20.00','30.00','40.00'])
    expect(b.withoutTime).toEqual({ count: 1, amount: '20.02' })
    expect(b.hours[0]).toEqual({ key: 0, count: 1, amount: '10.01' })
    expect(b.hours[23]).toEqual({ key: 23, count: 1, amount: '30.03' })
    expect(b.monthDays[6]).toEqual({ key: 7, count: 2, amount: '60.06' })
    expect(b.weekdays[0]).toEqual({ key: 1, count: 2, amount: '60.06' })
    for (const buckets of [b.monthDays, b.weekdays]) expect(buckets.reduce((s,r)=>s+r.count,0)).toBe(4)
    expect(b.hours.reduce((s,r)=>s+r.count,0)+b.withoutTime.count).toBe(4)
    expect(b.hours).toHaveLength(24);expect(b.monthDays).toHaveLength(31);expect(b.weekdays).toHaveLength(7)
  })
  it('agrees with Caja and overview under identical scope', async () => {
    const q = req('agent=royal')
    const b = await (await deposits(q)).json(), cash = await (await caja(q)).json(), activity = await (await overview(q)).json()
    expect(cash.totals.depositos).toBe(b.total.amount)
    for (const p of b.platforms) expect(activity.activity.find((r: { platform: string; agente: string | null }) => r.platform===p.platform && r.agente===null).depositos).toBe(p.amount)
  })
  it('keeps Caja pagination and totals consistent, including an empty page and a text filter', async () => {
    const full = await (await caja(req('agent=royal&per_page=100'))).json()
    const pages = []
    for (let page = 1; page <= Math.ceil(full.total / 2); page++) {
      const part = await (await caja(req(`agent=royal&per_page=2&page=${page}`))).json()
      expect(part.total).toBe(full.total); expect(part.totals).toEqual(full.totals)
      pages.push(...part.rows)
    }
    expect(pages).toEqual(full.rows)
    expect(new Set(pages.map(row => row.id)).size).toBe(full.total)
    const empty = await (await caja(req('agent=royal&per_page=2&page=999'))).json()
    expect(empty.rows).toEqual([]); expect(empty.totals).toEqual(full.totals)
    const filtered = await (await caja(req('agent=royal&search=adminroyal&search_by=agente'))).json()
    expect(filtered.rows.every((row: {agente: string}) => row.agente==='adminroyal')).toBe(true)
    expect(filtered.total).toBe(2)
    expect(full.rows.find((row: {id: string})=>row.id==='1').fecha_hora_utc).toBe('2026-09-01T03:00:00.000Z')
  })
  it('does not mix the same agent on different platforms and recognizes saved aliases', async () => {
    const b = await (await deposits(new Request('http://localhost/?platform=bet30&agent=bigwin&from=2026-09-01&to=2026-09-30'))).json()
    expect(b.total).toEqual({ count: 1, amount: '4.50' })
    expect((await (await deposits(req('agent=adminroyal'))).json()).total.amount).toBe('100.10')
  })
  it('sums same calendar days across months and preserves unknown times', async () => {
    const b = await (await deposits(new Request('http://localhost/?platform=consolidado&agent=royal&from=2026-08-01&to=2026-09-30'))).json()
    expect(b.total.count).toBe(6);expect(b.monthDays[30].count).toBe(1);expect(b.monthDays[6].count).toBe(3)
    expect(b.weekdays.reduce((s: number,r: {count: number})=>s+r.count,0)).toBe(6)
  })
  it('an empty period yields zero-filled graphs, invalid scope yields 400', async () => {
    const b = await (await deposits(new Request('http://localhost/?from=2020-01-01&to=2020-01-02'))).json()
    expect(b.total).toEqual({ count: 0, amount: '0' });expect(b.hours.every((r: {count: number})=>r.count===0)).toBe(true)
    expect((await deposits(new Request('http://localhost/?from=2026-02-30&to=2026-03-01'))).status).toBe(400)
    expect((await deposits(new Request('http://localhost/?platform=unknown'))).status).toBe(400)
  })
})
