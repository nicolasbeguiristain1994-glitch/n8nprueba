// @vitest-environment node
/**
 * POST /api/dashboard/casino/sync — route-level tests (mocks; sin DB ni procesos reales)
 *
 * Covers:
 *  1. Auth: 401 passthrough, 403 para no-admin (rol fresco de la DB)
 *  2. Validación: plataformas sin conector, fechas, agentes → 400 controlado
 *  3. Credenciales faltantes → 503
 *  4. Corrida en curso → 409; migración pendiente → 503
 *  5. Lanzamiento sin shell: spawn(node, argv) + run_id registrado y devuelto (202)
 *  6. Fallos de arranque (error de spawn, salida temprana) quedan registrados
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: vi.fn() }))
vi.mock('child_process', () => {
  const spawn = vi.fn()
  return { spawn, default: { spawn } }
})

import { spawn } from 'child_process'
import { NextResponse } from 'next/server'
import * as db from '@/lib/db'
import * as permissions from '@/lib/permissions'
import { POST } from '@/app/api/dashboard/casino/sync/route'

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function makeReq(qs = ''): Request {
  return new Request(`http://localhost/api/dashboard/casino/sync${qs}`, { method: 'POST' })
}

function asRole(role: 'admin' | 'operator' | 'viewer') {
  vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
    ok:   true,
    user: { user_id: 'u1', role, sectors: ['dashboard'] },
  } as never)
}

type FakeChild = EventEmitter & { unref: ReturnType<typeof vi.fn>; pid: number }

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { unref: vi.fn(), pid: 4242 })
}

const ENV_KEYS = ['ZEUS_API_KEY', 'ZEUS_ADMIN_USER', 'ZEUS_ADMIN_PASSWORD', 'ZEUS_PLAYER_TOKEN', 'BET30_API_KEY', 'BET30_PLAYER_TOKEN', 'CASINO_SYNC_PAUSED']
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  delete process.env.CASINO_SYNC_PAUSED   // los tests existentes corren sin pausa
  process.env.ZEUS_API_KEY        = 'k'
  process.env.ZEUS_ADMIN_USER     = 'u'
  process.env.ZEUS_ADMIN_PASSWORD = 'p'
  process.env.BET30_API_KEY       = 'k'
  process.env.BET30_PLAYER_TOKEN  = 't'
  asRole('admin')
  vi.mocked(db.query).mockResolvedValue([])
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/dashboard/casino/sync', () => {
  it('passes through the 401 from the permission check', async () => {
    vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
      ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const res = await POST(makeReq())
    expect(res.status).toBe(401)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects non-admin users with 403', async () => {
    asRole('operator')
    const res = await POST(makeReq())
    expect(res.status).toBe(403)
    expect(spawn).not.toHaveBeenCalled()
  })

  describe('pausa operativa (CASINO_SYNC_PAUSED)', () => {
    it.each(['1', 'true', 'valor-desconocido'])('con %s responde 503 sin validar, consultar ni lanzar procesos', async value => {
      process.env.CASINO_SYNC_PAUSED = value
      vi.mocked(spawn).mockReturnValue(fakeChild() as never)

      const res  = await POST(makeReq('?platform=zeus&desde=2026-01-01&hasta=2026-01-31'))
      const body = await res.json()

      expect(res.status).toBe(503)
      expect(body.code).toBe('CASINO_SYNC_PAUSED')
      expect(body.error).toMatch(/pausadas/)
      expect(db.query).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      // no expone configuración ni variables
      expect(JSON.stringify(body)).not.toMatch(/ZEUS_|BET30_|DATABASE_URL/)
    })

    it('la autenticación sigue primero: 401 pasa aunque esté pausado', async () => {
      process.env.CASINO_SYNC_PAUSED = '1'
      vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
        ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      } as never)
      expect((await POST(makeReq())).status).toBe(401)
      expect(permissions.checkPermissionWithUser).toHaveBeenCalledWith(expect.any(Request), 'dashboard', 'read')
    })

    it('un no-admin sigue recibiendo 403 aunque esté pausado', async () => {
      process.env.CASINO_SYNC_PAUSED = '1'
      asRole('operator')
      expect((await POST(makeReq())).status).toBe(403)
    })

    it.each(['0', 'false', ''])('con %p el disparo sigue funcionando', async value => {
      process.env.CASINO_SYNC_PAUSED = value
      vi.mocked(spawn).mockReturnValue(fakeChild() as never)
      const res = await POST(makeReq('?platform=zeus'))
      expect(res.status).toBe(202)
      expect(spawn).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['argenbet', 'ganamos'])('rejects %s (no connector) with a controlled 400, not a 500', async platform => {
    const res  = await POST(makeReq(`?platform=${platform}`))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/no tiene conector/)
    expect(body.error).toMatch(/zeus, bet30/)
    expect(db.query).not.toHaveBeenCalled()
  })

  it.each([
    ['?platform=consolidado',                    /Plataforma inválida/],
    ['?platform=zeus;rm',                        /Plataforma inválida/],
    ['?hasta=2026-01-31',                        /requiere "desde"/],
    ['?desde=2026-02-30',                        /"desde"/],
    ['?desde=2026-01-31&hasta=2026-01-01',       /posterior/],
    ['?desde=2026-01-01&hasta=2999-01-01',       /futura/],
    ['?desde=2020-01-01&hasta=2026-01-01',       /366 días/],
    ['?agentes=betcoin,$(reboot)',               /inválidos/],
    ['?agentes=,,',                              /vacío/],
  ])('rejects %s with 400', async (qs, message) => {
    const res = await POST(makeReq(qs))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns 503 when the platform credentials are not configured', async () => {
    delete process.env.ZEUS_API_KEY
    const res = await POST(makeReq('?platform=zeus'))
    expect(res.status).toBe(503)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns 409 when a run of the same platform is in progress', async () => {
    vi.mocked(db.query).mockResolvedValueOnce([{ run_id: 'running-id' }])
    const res = await POST(makeReq('?platform=zeus'))
    expect(res.status).toBe(409)
    expect((await res.json()).run_id).toBe('running-id')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns 503 MIGRATION_PENDING when casino_sync_runs does not exist', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
    const res = await POST(makeReq('?platform=zeus'))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('MIGRATION_PENDING')
  })

  it('launches node with explicit argv (no shell), pre-registers and returns the run_id (202)', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)

    const res  = await POST(makeReq('?platform=zeus'))
    const body = await res.json()

    expect(res.status).toBe(202)
    expect(body).toMatchObject({ ok: true, status: 'started', platform: 'zeus', mode: 'auto' })
    expect(body.run_id).toMatch(UUID_RE)
    expect(body.message).not.toMatch(/actualizar[aá]n en/)

    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(cmd).toBe(process.execPath)
    expect(cmd).not.toBe('sh')
    expect(args[0]).toMatch(/scripts[\\/]casino-sync-and-segment\.js$/)
    expect(args).toEqual(expect.arrayContaining([`--run-id=${body.run_id}`, '--platform=zeus', '--trigger=api', '--auto']))
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalled()

    const insert = vi.mocked(db.query).mock.calls.find(c => /INSERT INTO casino_sync_runs/.test(String(c[0])))
    expect(insert?.[1]?.[0]).toBe(body.run_id)
    // pre-registro sin runner: instance_id NULL (el runner solo adopta filas así)
    expect(String(insert?.[0])).toMatch(/'pending', NULL\)/)
    expect(insert?.[1]).toHaveLength(6)
  })

  it('only confirms that the run started (chunks commit as they finish)', async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild() as never)
    const body = await (await POST(makeReq('?platform=zeus'))).json()
    expect(body.message).toMatch(/aceptada/)
    expect(body.message).not.toMatch(/Monitoreo/)
    expect(body.message).not.toMatch(/hasta que la corrida termine|actualizar[aá]n en/)
  })

  it('passes range and agents as separate argv entries', async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild() as never)
    const res = await POST(makeReq('?platform=bet30&desde=2026-01-01&hasta=2026-01-31&agentes=btcuno,%20btcdos'))
    expect(res.status).toBe(202)
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining([
      '--platform=bet30', '--desde=2026-01-01', '--hasta=2026-01-31', '--agentes=btcuno,btcdos',
    ]))
    expect(args).not.toContain('--auto')
  })

  it('records SPAWN_FAILED when the child emits an error', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const res = await POST(makeReq('?platform=zeus'))
    const { run_id } = await res.json()

    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    await new Promise(r => setImmediate(r))

    const update = vi.mocked(db.query).mock.calls.find(c => /UPDATE casino_sync_runs/.test(String(c[0])))
    expect(update?.[1]).toEqual([run_id, 'SPAWN_FAILED', expect.any(String)])
  })

  it('records CHILD_EXIT when the child exits non-zero, and nothing on exit 0', async () => {
    const ok = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(ok as never)
    await POST(makeReq('?platform=zeus'))
    ok.emit('exit', 0)
    await new Promise(r => setImmediate(r))
    expect(vi.mocked(db.query).mock.calls.some(c => /UPDATE casino_sync_runs/.test(String(c[0])))).toBe(false)

    const bad = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(bad as never)
    await POST(makeReq('?platform=zeus'))
    bad.emit('exit', 2)
    await new Promise(r => setImmediate(r))
    const update = vi.mocked(db.query).mock.calls.find(c => /UPDATE casino_sync_runs/.test(String(c[0])))
    expect(update?.[1]?.[1]).toBe('CHILD_EXIT')
    expect(String(update?.[0])).toMatch(/WHERE run_id = \$1 AND status = 'running'/)
  })

  it('returns 500 and records SPAWN_FAILED when spawn throws synchronously', async () => {
    vi.mocked(spawn).mockImplementation(() => { throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }) })
    const res = await POST(makeReq('?platform=zeus'))
    expect(res.status).toBe(500)
    const update = vi.mocked(db.query).mock.calls.find(c => /UPDATE casino_sync_runs/.test(String(c[0])))
    expect(update?.[1]?.[1]).toBe('SPAWN_FAILED')
  })
})
