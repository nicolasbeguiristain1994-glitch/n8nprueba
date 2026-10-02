// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn().mockResolvedValue(undefined) }))
import { query } from '@/lib/db'
import { overviewSql as newOverview } from '@/lib/dashboard-overview'
import { overviewSql as oldOverview } from './fixtures/overview-before-completion'
import { GET as current } from '@/app/api/dashboard/casino/route'
import { GET as previous } from './fixtures/casino-before-audit'
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort().map(([k,value]) => [k,stable(value)])) : v

describe.skipIf(process.env.RUN_DASHBOARD_PRODUCTION_READONLY !== '1')('bounded dashboard ledger, production SELECT-only comparison', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (url.hostname !== 'aws-1-us-east-2.pooler.supabase.com' || url.pathname !== '/postgres') throw Error('Unexpected destination')
    db = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 })
    await db.connect()
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'")
    expect((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
    mocks()
  }, 20000)
  function mocks() {
    vi.mocked(query).mockImplementation(async (sql, params) => {
      if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(sql)) throw Error('Read-only required')
      return (await db.query(sql, params)).rows
    })
  }
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  it('preserves historical overview results while reducing date aggregation', async () => {
    const args=['2026-09-22','2026-09-23',null]
    const start=Date.now(),old=(await db.query(oldOverview('consolidado'),args)).rows,oldMs=Date.now()-start
    const fresh=Date.now(),next=(await db.query(newOverview('consolidado'),args)).rows,newMs=Date.now()-fresh
    expect(stable(next)).toEqual(stable(old));console.log(JSON.stringify({scope:'overview-consolidado',oldMs,newMs,equal:true}))
  },60000)
  for (const scope of ['platform=zeus','platform=consolidado','platform=consolidado&agent=royal']) {
    it('preserves all metrics for ' + scope, async () => {
      const req = new Request('http://localhost/?from=2026-09-29&to=2026-09-30&' + scope)
      const t = Date.now(), old = await previous(req), oldMs = Date.now()-t
      expect(old.status).toBe(200)
      const previousBody = await old.json(), start = Date.now(), now = await current(req), newMs = Date.now()-start
      expect(now.status).toBe(200)
      expect(stable(await now.json())).toEqual(stable(previousBody))
      console.log(JSON.stringify({ scope, oldMs, newMs, equal: true }))
    }, 60000)
  }
})
