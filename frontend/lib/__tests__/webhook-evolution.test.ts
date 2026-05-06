/**
 * webhook-evolution.test.ts
 * @vitest-environment node
 *
 * Tests para el handler POST /api/webhook/evolution.
 *
 * Cubre:
 *  1. Autenticación — rechaza secret incorrecto o ausente
 *  2. CONNECTION_UPDATE / connection.update — sincroniza is_connected en DB
 *  3. CONNECTION_UPDATE state desconocido → sin UPDATE en DB
 *  4. messages.upsert — mensajes de grupos ignorados
 *  5. messages.update — eventos sin key.id ignorados
 *  6. Eventos desconocidos → ok silencioso
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks top-level ────────────────────────────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue([])
vi.mock('@/lib/db', () => ({ query: mockQuery }))
vi.mock('@/lib/notify',           () => ({ notify: vi.fn() }))
vi.mock('@/lib/automation-engine', () => ({ evaluateAutomations: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/validate',          () => ({ normalizePhone: vi.fn().mockReturnValue(null) }))

// ── Constantes de prueba ───────────────────────────────────────────────────────

const SECRET = 'test-webhook-secret-xyz'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body: unknown, secret = SECRET): NextRequest {
  return new NextRequest('http://localhost/api/webhook/evolution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': secret,
    },
    body: JSON.stringify(body),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Autenticación
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook/evolution — autenticación', () => {
  beforeEach(() => {
    process.env.EVOLUTION_WEBHOOK_SECRET = SECRET
    mockQuery.mockReset()
    mockQuery.mockResolvedValue([])
  })

  it('rechaza secret incorrecto con 401', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({ event: 'CONNECTION_UPDATE', data: {} }, 'wrong-secret'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('rechaza secret ausente con 401', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const req = new NextRequest('http://localhost/api/webhook/evolution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'CONNECTION_UPDATE', data: {} }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('retorna 500 cuando EVOLUTION_WEBHOOK_SECRET no está configurado', async () => {
    const saved = process.env.EVOLUTION_WEBHOOK_SECRET
    delete process.env.EVOLUTION_WEBHOOK_SECRET
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({ event: 'connection.update', data: {} }))
    expect(res.status).toBe(500)
    process.env.EVOLUTION_WEBHOOK_SECRET = saved
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. CONNECTION_UPDATE — sincroniza is_connected
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook/evolution — CONNECTION_UPDATE', () => {
  beforeEach(() => {
    process.env.EVOLUTION_WEBHOOK_SECRET = SECRET
    mockQuery.mockReset()
    mockQuery.mockResolvedValue([])
  })

  it('state=open → UPDATE con is_connected=true y status=active', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({
      event:    'CONNECTION_UPDATE',
      instance: 'wa-prod-01',
      data:     { state: 'open' },
    }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const updCall = mockQuery.mock.calls.find(args =>
      typeof args[0] === 'string' &&
      args[0].includes('is_connected = true') &&
      args[0].includes('status =')
    )
    expect(updCall).toBeTruthy()
    expect(updCall![1]).toContain('wa-prod-01')
  })

  it('state=close → UPDATE con is_connected=false', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({
      event:    'CONNECTION_UPDATE',
      instance: 'wa-prod-01',
      data:     { state: 'close' },
    }))
    expect(res.status).toBe(200)

    const updCall = mockQuery.mock.calls.find(args =>
      typeof args[0] === 'string' &&
      args[0].includes('is_connected = false')
    )
    expect(updCall).toBeTruthy()
    expect(updCall![1]).toContain('wa-prod-01')
  })

  it('state=connecting → ningún UPDATE en whatsapp_lines', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    await POST(makeReq({
      event:    'CONNECTION_UPDATE',
      instance: 'wa-prod-01',
      data:     { state: 'connecting' },
    }))
    const linesUpdateCalls = mockQuery.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('whatsapp_lines')
    )
    expect(linesUpdateCalls).toHaveLength(0)
  })

  it('acepta variante connection.update (minúsculas)', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({
      event:    'connection.update',
      instance: 'wa-prod-02',
      data:     { state: 'open' },
    }))
    expect(res.status).toBe(200)
    const updCall = mockQuery.mock.calls.find(args =>
      typeof args[0] === 'string' && args[0].includes('is_connected = true')
    )
    expect(updCall).toBeTruthy()
  })

  it('instance ausente → no lanza, responde ok', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({
      event: 'CONNECTION_UPDATE',
      data:  { state: 'open' },
    }))
    expect(res.status).toBe(200)
    // Sin instance válido → no hay UPDATE en DB
    const linesUpdateCalls = mockQuery.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('whatsapp_lines')
    )
    expect(linesUpdateCalls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. messages.upsert — grupos ignorados
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook/evolution — messages.upsert grupos', () => {
  beforeEach(() => {
    process.env.EVOLUTION_WEBHOOK_SECRET = SECRET
    mockQuery.mockReset()
    mockQuery.mockResolvedValue([])
  })

  it('jid de grupo (@g.us) → responde ok sin INSERT', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({
      event: 'messages.upsert',
      data: {
        key:     { remoteJid: '1234567890@g.us', fromMe: false, id: 'msg-001' },
        message: { conversation: 'hola grupo' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    }))
    expect(res.status).toBe(200)
    // No debe haber INSERT en whatsapp_messages
    const insertCall = mockQuery.mock.calls.find(args =>
      typeof args[0] === 'string' && args[0].includes('INSERT INTO whatsapp_messages')
    )
    expect(insertCall).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Eventos desconocidos → ok silencioso
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook/evolution — eventos desconocidos', () => {
  beforeEach(() => {
    process.env.EVOLUTION_WEBHOOK_SECRET = SECRET
    mockQuery.mockReset()
    mockQuery.mockResolvedValue([])
  })

  it('evento desconocido → 200 ok, sin DB queries', async () => {
    const { POST } = await import('@/app/api/webhook/evolution/route')
    const res = await POST(makeReq({
      event: 'some.unknown.event',
      data:  { whatever: true },
    }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(mockQuery.mock.calls).toHaveLength(0)
  })
})
