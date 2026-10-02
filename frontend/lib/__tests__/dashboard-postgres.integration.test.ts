// @vitest-environment node
// Explicit opt-in. Only temporary fixtures on a verified loopback PostgreSQL.
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn().mockResolvedValue(undefined), checkPermissionWithUser: vi.fn().mockResolvedValue({ ok: true, user: { role: 'admin' } }) }))
import { query } from '@/lib/db'
import { GET as casino } from '@/app/api/dashboard/casino/route'
import { GET as overview } from '@/app/api/dashboard/casino/overview/route'
import { GET as crm } from '@/app/api/dashboard/crm/route'
import { GET as caja } from '@/app/api/dashboard/caja/route'

describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS !== '1')('dashboard SQL against PostgreSQL', () => {
  let client: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local database required')
    client = new Client({ connectionString: url.toString(), ssl: false })
    await client.connect()
    await client.query('BEGIN')
    await client.query(`CREATE TEMP TABLE casino_financial_source_records(platform text,source_id text,kind text,transaction_id bigint,agente text,username text,monto numeric,fecha date,fecha_hora_utc timestamptz) ON COMMIT DROP`)
    await client.query(`CREATE TEMP TABLE casino_transactions (
      id bigint, id_rec bigint, fecha date, fecha_hora_utc timestamptz, platform text,
      agente text, username text, tipo text, monto numeric, raw_detalles text
    ) ON COMMIT DROP`)
    await client.query(`CREATE TEMP TABLE casino_dashboard_players (
      username_lower text, platform text, agente text, fecha_primera date, fecha_ultima date,
      seg_monto text, seg_actividad text, total_cargas numeric, total_retiros numeric,
      cant_cargas int, cant_retiros int
    ) ON COMMIT DROP`)
    await client.query(`INSERT INTO casino_transactions (id,id_rec,fecha,platform,agente,username,tipo,monto) VALUES
      (1,9007199254740993,'2026-09-22','ganamos','adminbtc','shared','carga',100.25),
      (2,2,'2026-09-23','ganamos','adminbtc','shared','retiro',30.10),
      (3,3,'2026-09-24','ganamos','adminbtc','shared','carga',999),
      (4,4,'2026-09-22','argenbet','adminbtc','shared','carga',200.33),
      (5,5,'2026-09-22','zeus','bigwin','shared','carga',300.45),
      (6,6,'2026-09-22','bet30','bigwin','shared','carga',400.55),
      (7,7,'2026-09-22',NULL,'bigwin','ambiguous','carga',99999),
      (8,8,'2026-09-21','ganamos','adminbtc','prior','carga',70),
      (9,9,'2026-09-22','ganamos','adminroyal','moved','carga',20.05),
      (10,10,'2026-09-23','ganamos','adminbtc','moved','carga',10.01)`)
    await client.query(`INSERT INTO casino_dashboard_players VALUES
      ('shared','ganamos','adminbtc','2026-09-22','2026-09-24','vip_medio','activo',1099.25,30.10,2,1),
      ('prior','ganamos','adminbtc','2026-09-21','2026-09-21','vip_alto','inactivo',70,0,1,0),
      ('moved','ganamos','adminbtc','2026-09-22','2026-09-23','bajo','activo',30.06,0,2,0),
      ('shared','argenbet','adminbtc','2026-09-22','2026-09-22','vip','activo',200.33,0,1,0),
      ('shared','zeus','bigwin','2026-09-22','2026-09-22','bajo','activo',300.45,0,1,0),
      ('shared','bet30','bigwin','2026-09-22','2026-09-22','bajo','activo',400.55,0,1,0)`)
    await client.query(`ALTER TABLE casino_dashboard_players ADD COLUMN first_deposit_agent text`)
    await client.query(`UPDATE casino_dashboard_players SET first_deposit_agent=CASE WHEN username_lower='moved' THEN 'adminroyal' ELSE agente END`)
    await client.query(`CREATE TEMP TABLE tasks (id text, title text, due_date timestamptz, priority text, status text, deleted_at timestamptz, updated_at timestamptz) ON COMMIT DROP`)
    await client.query(`CREATE TEMP TABLE task_assignees (task_id text, user_id text) ON COMMIT DROP`)
    await client.query(`CREATE TEMP TABLE users (id text, name text, email text) ON COMMIT DROP`)
    await client.query(`CREATE TEMP TABLE contacts (first_name text, last_name text, phone_number text, created_at timestamptz, deleted_at timestamptz) ON COMMIT DROP`)
    await client.query(`INSERT INTO tasks VALUES
      ('1','Pendiente',NOW() - INTERVAL '1 day','alta','pendiente',NULL,NOW()),
      ('2','Terminada',NULL,'media','completada',NULL,NOW()),
      ('3','Cancelada',NULL,'media','cancelada',NULL,NOW()),
      ('4','Eliminada',NULL,'media','pendiente',NOW(),NOW())`)
    await client.query(`INSERT INTO users VALUES ('u1','Operador de prueba','test@example.invalid')`)
    await client.query(`INSERT INTO task_assignees VALUES ('1','u1')`)
    let queued: Promise<unknown> = Promise.resolve()
    vi.mocked(query).mockImplementation((sql, params) => {
      const next = queued.then(() => client.query(sql, params))
      queued = next.catch(() => undefined)
      return next.then(result => result.rows)
    })
  })
  afterAll(async () => { if (client) { await client.query('ROLLBACK'); await client.end() } })
  const request = (endpoint: string, extra = '') => new Request(`http://localhost/api/dashboard/${endpoint}?from=2026-09-22&to=2026-09-23&${extra}`)

  it('counts imported accounts and historical activity even with a newer deposit', async () => {
    const res = await casino(request('casino', 'platform=ganamos&agent=adminbtc'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary).toMatchObject({ nuevos_mes: 1, activos_mes: 2, nuevos_anterior: 1, activos_anterior: 1, total_vip: 2, prioridad_reactivacion: 1, total_jugadores: 3 })
    expect(body.agentes[0]).toMatchObject({ agente: 'adminbtc', sum_cargas: 110.26, sum_retiros: 30.1 })
    expect(typeof body.agentes[0].response_rate).toBe('number')
  })
  it('includes movements under the original agent after an account changes agent', async () => {
    const body = await (await casino(request('casino', 'platform=ganamos&agent=adminroyal'))).json()
    expect(body.summary.activos_mes).toBe(1)
    expect(body.summary.nuevos_mes).toBe(1)
    expect(body.agentes[0]).toMatchObject({ agente: 'adminroyal', sum_cargas: 20.05, activos_mes: 1, nuevos_mes: 1 })
  })
  it('separates all four platforms, excludes ambiguous legacy rows and preserves decimal totals', async () => {
    const body = await (await overview(request('casino/overview', 'platform=consolidado'))).json()
    const totals = body.activity.filter((r: { agente: string | null }) => r.agente === null)
    expect(totals).toHaveLength(4)
    expect(totals.find((r: { platform: string }) => r.platform === 'ganamos')).toMatchObject({ depositos: '130.31', retiros: '30.10', neto: '100.21', cuentas: 2, movimientos: 4, ultima_fecha: '2026-09-24' })
    expect(totals.find((r: { platform: string }) => r.platform === 'bet30').depositos).toBe('400.55')
  })
  it('Caja honors platform, agent, dates, search and preserves bigint identifiers', async () => {
    const body = await (await caja(request('caja', 'platform=ganamos&agent=adminbtc&search=shared'))).json()
    expect(body.total).toBe(2)
    expect(body.totals).toEqual({ depositos: '100.25', retiros: '30.10', saldo: '70.15', deposito_bonificado: '0' })
    expect(body.rows.map((r: { id_rec: string }) => r.id_rec)).toContain('9007199254740993')
    expect(body.rows[0].fecha).toBe('2026-09-23')
  })
  it('CRM uses real task states, assignments and excludes deleted tasks', async () => {
    const res = await crm(new NextRequest('http://localhost/api/dashboard/crm'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kpis).toMatchObject({ tasks_pending: 1, tasks_overdue: 1 })
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({ title: 'Pendiente', assigned_to: 'Operador de prueba' })
    expect(body.recent_activity).toHaveLength(1)
    expect(body.recent_activity[0].title).toBe('Terminada')
  })
  it('rejects invalid periods and platforms before querying', async () => {
    for (const handler of [casino, overview, caja]) {
      expect((await handler(request('casino', 'platform=invalid'))).status).toBe(400)
      expect((await handler(new Request('http://localhost/?from=2026-02-30&to=2026-03-02'))).status).toBe(400)
    }
    expect((await caja(request('caja', 'page=abc'))).status).toBe(400)
  })
})
