// @vitest-environment node
// Explicit deployment preflight: SELECT-only against the existing production schema.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn().mockResolvedValue(undefined),
  checkPermissionWithUser: vi.fn().mockResolvedValue({ ok: true, user: { role: 'admin' } }),
}))
import { query } from '@/lib/db'
import { GET as overview } from '@/app/api/dashboard/casino/overview/route'
import { GET as casino } from '@/app/api/dashboard/casino/route'
import { GET as caja } from '@/app/api/dashboard/caja/route'
import { GET as crm } from '@/app/api/dashboard/crm/route'

describe.skipIf(process.env.RUN_DASHBOARD_PRODUCTION_READONLY !== '1')('production dashboard read-only preflight', () => {
  let client: Client
  let connected = false
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (url.hostname !== 'aws-1-us-east-2.pooler.supabase.com' || url.pathname !== '/postgres') throw new Error('Unexpected destination')
    client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 })
    await client.connect(); connected = true
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10s'")
    expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
    let queue: Promise<unknown> = Promise.resolve()
    vi.mocked(query).mockImplementation((sql, params) => {
      if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(sql)) throw new Error('Read-only query required')
      const next = queue.then(() => client.query(sql, params))
      queue = next.catch(() => undefined)
      return next.then(result => result.rows)
    })
  }, 20000)
  afterAll(async () => { if (connected) { await client.query('ROLLBACK'); await client.end() } })
  const request = (platform: string) => new Request(`https://royalpulse.tech/api/dashboard?from=2026-09-22&to=2026-09-23&platform=${platform}`)
  it('financial overview matches Caja for each of the four platforms', async () => {
    const res = await overview(request('consolidado'))
    expect(res.status).toBe(200)
    const body = await res.json()
    for (const platform of ['zeus', 'bet30', 'ganamos', 'argenbet']) {
      const row = body.activity.find((r: { platform: string; agente: string | null }) => r.platform === platform && r.agente === null)
      expect(row).toBeDefined()
      const cajaResponse = await caja(request(platform))
      expect(cajaResponse.status).toBe(200)
      const cash = await cajaResponse.json()
      expect(cash.total).toBe(row.movimientos)
      expect(cash.totals.depositos).toBe(row.depositos)
      expect(cash.totals.retiros).toBe(row.retiros)
      expect(cash.totals.deposito_bonificado).toBe(row.bonos)
      expect(cash.totals.saldo).toBe(row.saldo_con_bonos)
    }
  }, 60000)
  it('account indicators and segments work on the existing schema', async () => {
    const response = await casino(request('consolidado'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.summary.total_jugadores).toBeGreaterThan(0)
    expect(body.agentes.length).toBeGreaterThan(0)
    expect(body.vips.every((v: { seg_actividad: string }) => ['inactivo', 'en_riesgo', 'perdido'].includes(v.seg_actividad))).toBe(true)
  }, 60000)
  it('CRM task queries are compatible with the deployed database', async () => {
    expect((await crm(new NextRequest('https://royalpulse.tech/api/dashboard/crm'))).status).toBe(200)
  }, 30000)
})
