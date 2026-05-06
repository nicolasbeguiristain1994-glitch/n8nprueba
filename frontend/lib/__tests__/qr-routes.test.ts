/**
 * qr-routes.test.ts
 * @vitest-environment node
 *
 * Tests del flujo QR de Evolution API v2.
 *
 * Cubre:
 *  1. parseInstancesResponse — distintos shapes de fetchInstances
 *  2. Detección de notFound (404, array vacío, null)
 *  3. Detección de state: close / connecting / open
 *  4. Extracción de phone_number desde ownerJid y variantes
 *  5. GET /api/lines/qr/status — happy paths + notFound
 *  6. GET /api/lines/qr — connecting no devuelve QR; ya conectada devuelve connected
 *  7. Restart bloqueado cuando state = open
 *  8. Restart hace logout cuando state = connecting
 *  9. El polling de status NUNCA llama a /instance/connect
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { parseInstancesResponse } from '@/lib/evolution-utils'

// ── Mocks top-level (hoistados por vitest) ────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue([])
vi.mock('@/lib/db',          () => ({ query: mockQuery }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/audit',       () => ({ audit: vi.fn() }))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(path: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return new NextRequest(url.toString())
}

function evoRes(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. parseInstancesResponse — tests unitarios del helper de parseo
// ─────────────────────────────────────────────────────────────────────────────

describe('parseInstancesResponse', () => {
  it('Shape A — array con instance.state = open', () => {
    const body = [{ instance: { instanceName: 'x', state: 'open' }, ownerJid: '5491100000@s.whatsapp.net' }]
    const r = parseInstancesResponse(200, body)
    expect(r.state).toBe('open')
    expect(r.phone_number).toBe('+5491100000')
  })

  it('Shape A — array con instance.status = connecting', () => {
    const body = [{ instance: { instanceName: 'x', status: 'connecting' } }]
    const r = parseInstancesResponse(200, body)
    expect(r.state).toBe('connecting')
    expect(r.phone_number).toBeNull()
  })

  it('Shape B — connectionStatus anidado', () => {
    const body = [{ instance: { instanceName: 'x' }, connectionStatus: { state: 'open' }, ownerJid: '5491100001@s.whatsapp.net' }]
    const r = parseInstancesResponse(200, body)
    expect(r.state).toBe('open')
    expect(r.phone_number).toBe('+5491100001')
  })

  it('Shape C — objeto plano v1-compat', () => {
    const body = { instanceName: 'x', state: 'open', ownerJid: '5491100002@s.whatsapp.net' }
    const r = parseInstancesResponse(200, body)
    expect(r.state).toBe('open')
    expect(r.phone_number).toBe('+5491100002')
  })

  it('HTTP 404 → notFound', () => {
    expect(parseInstancesResponse(404, {}).state).toBe('notFound')
  })

  it('Array vacío → notFound', () => {
    expect(parseInstancesResponse(200, []).state).toBe('notFound')
  })

  it('null body → notFound', () => {
    expect(parseInstancesResponse(200, null).state).toBe('notFound')
  })

  it('state close sin owner', () => {
    const r = parseInstancesResponse(200, [{ instance: { state: 'close' } }])
    expect(r.state).toBe('close')
    expect(r.phone_number).toBeNull()
  })

  it('ownerJid en instance.owner', () => {
    const r = parseInstancesResponse(200, [{ instance: { state: 'open', owner: '5491100003@s.whatsapp.net' } }])
    expect(r.phone_number).toBe('+5491100003')
  })

  it('número plano sin @ en field number', () => {
    const r = parseInstancesResponse(200, [{ instance: { state: 'open' }, number: '5491100004' }])
    expect(r.phone_number).toBe('+5491100004')
  })

  it('state en uppercase se normaliza', () => {
    expect(parseInstancesResponse(200, [{ instance: { state: 'OPEN' } }]).state).toBe('open')
  })

  it('phone_number es null en estado close (no exponer número a medias)', () => {
    const r = parseInstancesResponse(200, [{ instance: { state: 'close' }, ownerJid: '5491100005@s.whatsapp.net' }])
    expect(r.phone_number).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/lines/qr/status
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/lines/qr/status', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockQuery.mockResolvedValue([])
  })

  it('devuelve notFound cuando connectionState retorna 404', async () => {
    mockFetch.mockResolvedValueOnce(evoRes({}, 404))
    const { GET } = await import('@/app/api/lines/qr/status/route')
    const res  = await GET(makeReq('/api/lines/qr/status', { instance: 'my-instance' }))
    const body = await res.json()
    expect(body.state).toBe('notFound')
    expect(body.notFound).toBe(true)
    expect(body.connected).toBe(false)
  })

  it('devuelve state close cuando connectionState retorna objeto sin estado reconocido', async () => {
    mockFetch.mockResolvedValueOnce(evoRes({}, 200))
    const { GET } = await import('@/app/api/lines/qr/status/route')
    const res  = await GET(makeReq('/api/lines/qr/status', { instance: 'my-instance' }))
    const body = await res.json()
    expect(body.state).toBe('close')
    expect(body.connected).toBe(false)
  })

  it('devuelve state connecting', async () => {
    mockFetch.mockResolvedValueOnce(
      evoRes({ instance: { instanceName: 'my-instance', state: 'connecting' } }),
    )
    const { GET } = await import('@/app/api/lines/qr/status/route')
    const body = await (await GET(makeReq('/api/lines/qr/status', { instance: 'my-instance' }))).json()
    expect(body.state).toBe('connecting')
    expect(body.connected).toBe(false)
  })

  it('devuelve connected y phone_number cuando state = open', async () => {
    // 1er fetch: connectionState → state=open
    mockFetch.mockResolvedValueOnce(
      evoRes({ instance: { instanceName: 'my-instance', state: 'open' } }),
    )
    // 2do fetch: fetchInstances → ownerJid para phone_number
    mockFetch.mockResolvedValueOnce(
      evoRes([{ instance: { state: 'open' }, ownerJid: '5491100000@s.whatsapp.net' }]),
    )
    const { GET } = await import('@/app/api/lines/qr/status/route')
    const body = await (await GET(makeReq('/api/lines/qr/status', { instance: 'my-instance' }))).json()
    expect(body.connected).toBe(true)
    expect(body.phone_number).toBe('+5491100000')
  })

  it('rechaza instance inválida con 400', async () => {
    const { GET } = await import('@/app/api/lines/qr/status/route')
    expect((await GET(makeReq('/api/lines/qr/status', { instance: 'bad name!' }))).status).toBe(400)
  })

  it('rechaza sin instance param con 400', async () => {
    const { GET } = await import('@/app/api/lines/qr/status/route')
    expect((await GET(makeReq('/api/lines/qr/status'))).status).toBe(400)
  })

  it('NUNCA llama a /instance/connect (solo connectionState)', async () => {
    mockFetch.mockResolvedValueOnce(evoRes({ instance: { state: 'close' } }))
    const { GET } = await import('@/app/api/lines/qr/status/route')
    await GET(makeReq('/api/lines/qr/status', { instance: 'my-instance' }))
    const calls = mockFetch.mock.calls.map((args: unknown[]) => args[0] as string)
    // /instance/connect/ (con barra final) no debe aparecer — distingue del endpoint
    // /instance/connectionState que sí es el correcto para polling
    expect(calls.every(u => !u.includes('/instance/connect/'))).toBe(true)
    expect(calls.some(u => u.includes('/instance/connectionState'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/lines/qr — generación de QR y lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/lines/qr', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockQuery.mockResolvedValue([])
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('devuelve base64 cuando la instancia está desconectada', async () => {
    mockFetch.mockResolvedValueOnce(
      evoRes({ base64: 'data:image/png;base64,AAAA', instance: { state: 'close' } }),
    )
    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()
    expect(body.connected).toBe(false)
    expect(body.base64).toBe('data:image/png;base64,AAAA')
  })

  it('devuelve connected: true cuando state = open', async () => {
    mockFetch
      .mockResolvedValueOnce(evoRes({ instance: { state: 'open' } }))
      .mockResolvedValueOnce(evoRes([{ instance: { state: 'open' }, ownerJid: '5491100000@s.whatsapp.net' }]))
    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()
    expect(body.connected).toBe(true)
  })

  it('devuelve state: connecting cuando instance está en handshake', async () => {
    mockFetch.mockResolvedValueOnce(evoRes({ instance: { state: 'connecting' } }))
    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()
    expect(body.state).toBe('connecting')
    expect(body.base64).toBeNull()
  })

  it('devuelve notFound cuando Evolution retorna 404', async () => {
    mockFetch.mockResolvedValueOnce(evoRes({ status: 404 }, 404))
    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()
    expect(body.notFound).toBe(true)
  })

  it('restart=true BLOQUEADO si la instancia ya está open', async () => {
    // getCurrentState → fetchInstances → open
    mockFetch.mockResolvedValueOnce(evoRes([{ instance: { state: 'open' } }]))
    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance', restart: 'true' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()
    expect(body.alreadyConnected).toBe(true)
    expect(body.connected).toBe(true)
    // No debe haber llamado a /instance/restart
    const calls = mockFetch.mock.calls.map((args: unknown[]) => args[0] as string)
    expect(calls.some(u => u.includes('/instance/restart'))).toBe(false)
  })

  it('restart=true con connecting hace logout antes de restart', async () => {
    mockFetch
      .mockResolvedValueOnce(evoRes([{ instance: { state: 'connecting' } }]))  // getCurrentState
      .mockResolvedValueOnce(evoRes({}, 200))                                   // logout
      .mockResolvedValueOnce(evoRes({}, 200))                                   // restart
      .mockResolvedValueOnce(evoRes({ base64: 'data:image/png;base64,BBBB' })) // /connect

    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance', restart: 'true' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()

    const calls = mockFetch.mock.calls.map((args: unknown[]) => args[0] as string)
    expect(calls.some(u => u.includes('/instance/logout'))).toBe(true)
    expect(calls.some(u => u.includes('/instance/restart'))).toBe(true)
    expect(body.base64).toBe('data:image/png;base64,BBBB')
  })

  it('qrcode.base64 también es extraído correctamente', async () => {
    mockFetch.mockResolvedValueOnce(evoRes({ qrcode: { base64: 'data:image/png;base64,QRQR' } }))
    const { GET } = await import('@/app/api/lines/qr/route')
    const promise = GET(makeReq('/api/lines/qr', { instance: 'my-instance' }))
    await vi.runAllTimersAsync()
    const body = await (await promise).json()
    expect(body.base64).toBe('data:image/png;base64,QRQR')
  })
})
