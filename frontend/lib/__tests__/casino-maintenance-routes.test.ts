// @vitest-environment node
/**
 * Pausa operativa CASINO_SYNC_PAUSED — helper y rutas administrativas
 * (mocks; sin DB, procesos ni red).
 *
 * Covers:
 *  1. isCasinoSyncPaused: sin definir/vacío/0/false no pausan; 1/true/valor
 *     desconocido pausan (fail-closed).
 *  2. GET /api/admin/test-casino-sync, POST /api/admin/resegment y
 *     POST /api/admin/migrate: con pausa → 503 CASINO_SYNC_PAUSED sin
 *     consultas, spawn ni migraciones.
 *  3. La autenticación/permisos originales siguen primero (401/403 pasan igual).
 *  4. Sin pausa, las rutas siguen haciendo lo que hacían.
 *  (POST /api/dashboard/casino/sync se cubre en casino-sync-route.test.ts.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSessionFromRequest: vi.fn() }))
vi.mock('child_process', () => {
  const spawn = vi.fn()
  return { spawn, default: { spawn } }
})

import { spawn } from 'child_process'
import { NextRequest, NextResponse } from 'next/server'
import * as db from '@/lib/db'
import * as permissions from '@/lib/permissions'
import * as auth from '@/lib/auth'
import { isCasinoSyncPaused, CASINO_SYNC_PAUSED_CODE } from '@/lib/casino-maintenance'
import { GET as testSyncGET } from '@/app/api/admin/test-casino-sync/route'
import { POST as resegmentPOST } from '@/app/api/admin/resegment/route'
import { POST as migratePOST } from '@/app/api/admin/migrate/route'

// ── Helpers ───────────────────────────────────────────────────────────────────

type FakeChild = EventEmitter & { unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; pid: number }

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(), pid: 4242 })
  // test-casino-sync espera 'close'; resegment no lo necesita.
  setImmediate(() => child.emit('close', 0))
  return child
}

const ROUTES = [
  { name: 'GET /api/admin/test-casino-sync', method: 'GET',  path: '/api/admin/test-casino-sync?platform=zeus', handler: testSyncGET },
  { name: 'POST /api/admin/resegment',       method: 'POST', path: '/api/admin/resegment',                     handler: resegmentPOST },
  { name: 'POST /api/admin/migrate',         method: 'POST', path: '/api/admin/migrate',                       handler: migratePOST },
] as const

function makeReq(method: string, p: string): NextRequest {
  return new NextRequest(`http://localhost${p}`, { method })
}

let savedPause: string | undefined

beforeEach(() => {
  vi.resetAllMocks()
  savedPause = process.env.CASINO_SYNC_PAUSED
  delete process.env.CASINO_SYNC_PAUSED
  vi.mocked(permissions.checkPermission).mockResolvedValue(null)
  vi.mocked(auth.getSessionFromRequest).mockReturnValue({ user_id: 'u1', role: 'admin' } as never)
  vi.mocked(db.query).mockResolvedValue([])
  vi.mocked(spawn).mockImplementation((() => fakeChild()) as never)
})

afterEach(() => {
  if (savedPause === undefined) delete process.env.CASINO_SYNC_PAUSED
  else process.env.CASINO_SYNC_PAUSED = savedPause
})

// ── Helper ────────────────────────────────────────────────────────────────────

describe('isCasinoSyncPaused', () => {
  it.each([[undefined], [''], ['  '], ['0'], ['false'], [' FALSE ']])('%p no pausa', value => {
    const env = value === undefined ? {} : { CASINO_SYNC_PAUSED: value }
    expect(isCasinoSyncPaused(env)).toBe(false)
  })

  it.each([['1'], ['true'], ['TRUE'], ['no'], ['off'], ['valor-desconocido']])('%p pausa (fail-closed)', value => {
    expect(isCasinoSyncPaused({ CASINO_SYNC_PAUSED: value })).toBe(true)
  })
})

// ── Rutas ─────────────────────────────────────────────────────────────────────

describe.each(ROUTES)('$name', ({ method, path, handler }) => {
  it('con pausa responde 503 CASINO_SYNC_PAUSED sin consultas, spawn ni migraciones', async () => {
    process.env.CASINO_SYNC_PAUSED = '1'
    const res  = await handler(makeReq(method, path))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.code).toBe(CASINO_SYNC_PAUSED_CODE)
    expect(body.error).toMatch(/pausadas/)
    expect(db.query).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    // sin diagnósticos ni presencia de variables en la respuesta
    expect(Object.keys(body).sort()).toEqual(['code', 'error'])
    expect(JSON.stringify(body)).not.toMatch(/ZEUS_|BET30_|DATABASE_URL|diagnostics/)
  })

  it('la verificación de permisos original corre primero y conserva su respuesta', async () => {
    process.env.CASINO_SYNC_PAUSED = '1'
    vi.mocked(permissions.checkPermission).mockResolvedValue(
      NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    )
    const req = makeReq(method, path)
    const res = await handler(req)

    expect(res.status).toBe(403)
    expect(permissions.checkPermission).toHaveBeenCalledWith(req, 'lines', 'manage')
    expect(spawn).not.toHaveBeenCalled()
    expect(db.query).not.toHaveBeenCalled()
  })

  it('sin pausa no responde CASINO_SYNC_PAUSED', async () => {
    process.env.CASINO_SYNC_PAUSED = '0'
    const res  = await handler(makeReq(method, path))
    const body = await res.json()
    expect(res.status).not.toBe(503)
    expect(body.code).not.toBe(CASINO_SYNC_PAUSED_CODE)
  })
})

describe('POST /api/admin/resegment — chequeo de rol', () => {
  it('un no-admin sigue recibiendo 403 aunque esté pausado', async () => {
    process.env.CASINO_SYNC_PAUSED = '1'
    vi.mocked(auth.getSessionFromRequest).mockReturnValue({ user_id: 'u2', role: 'operator' } as never)
    const res = await resegmentPOST(makeReq('POST', '/api/admin/resegment'))
    expect(res.status).toBe(403)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('sin pausa lanza la re-segmentación como antes', async () => {
    const res = await resegmentPOST(makeReq('POST', '/api/admin/resegment'))
    expect(res.status).toBe(200)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/admin/migrate — sin pausa', () => {
  it('ejecuta sus pasos como antes', async () => {
    const res = await migratePOST(makeReq('POST', '/api/admin/migrate'))
    expect(res.status).toBe(200)
    expect(vi.mocked(db.query).mock.calls.length).toBeGreaterThan(0)
  })
})
