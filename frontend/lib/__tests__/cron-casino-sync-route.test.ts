// @vitest-environment node
/**
 * cron-casino-sync-route.test.ts
 *
 * POST /api/cron/casino-sync — fase 4, único disparador programado de las 4
 * sincronizaciones de casino (D4). Cubre:
 *   - CRON_SECRET ausente/incorrecto -> 401/503, nunca corre el pipeline
 *   - éxito -> 200 con el resumen real (no solo "accepted")
 *   - fallo parcial (una plataforma cayó) -> 207 con el resumen real, no 200
 *   - un spawn error (ENOENT) nunca se reporta como éxito
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

const spawnMock = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

import { POST } from '@/app/api/cron/casino-sync/route'

type FakeChild = EventEmitter & { stdout: Readable; kill: (signal?: string) => void }

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new Readable({ read() {} })
  child.kill = () => {}
  return child
}

function req(headers: Record<string, string> = {}) {
  return new NextRequest(new Request('http://x/api/cron/casino-sync', { method: 'POST', headers }))
}

describe('POST /api/cron/casino-sync', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    process.env.CRON_SECRET = 'top-secret'
    process.env.DATABASE_URL = 'postgres://x'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.DATABASE_URL
  })

  it('503s when CRON_SECRET is not configured on the server, never runs the pipeline', async () => {
    delete process.env.CRON_SECRET
    const res = await POST(req({ 'x-cron-secret': 'anything' }))
    expect(res.status).toBe(503)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('401s on a missing/wrong secret, never runs the pipeline', async () => {
    const res = await POST(req({ 'x-cron-secret': 'wrong' }))
    expect(res.status).toBe(401)
    expect(spawnMock).not.toHaveBeenCalled()

    const res2 = await POST(req())
    expect(res2.status).toBe(401)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('returns 200 with the real per-platform summary when the pipeline succeeds', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const resPromise = POST(req({ 'x-cron-secret': 'top-secret' }))
    child.stdout.push(`PIPELINE_RESULT_JSON:${JSON.stringify({ ok: true, platformSummaries: [{ platform: 'zeus', status: 'ok' }] })}\n`)
    child.stdout.push(null)
    setImmediate(() => child.emit('close', 0))
    const res = await resPromise
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.platformSummaries[0].platform).toBe('zeus')
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath)
    expect(spawnMock.mock.calls[0][1]).toContain('--json')
  })

  it('returns 207 (never a plain 200) when the pipeline finishes but some platform failed', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const resPromise = POST(req({ 'x-cron-secret': 'top-secret' }))
    child.stdout.push(`PIPELINE_RESULT_JSON:${JSON.stringify({ ok: false, platformSummaries: [{ platform: 'ganamos', status: 'error', error: 'HTTP 401' }] })}\n`)
    child.stdout.push(null)
    setImmediate(() => child.emit('close', 1))
    const res = await resPromise
    const body = await res.json()

    expect(res.status).toBe(207)
    expect(body.ok).toBe(false)
    expect(body.platformSummaries[0].error).toContain('HTTP 401')
  })

  it('never reports success when the child process itself fails to spawn (ENOENT)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const resPromise = POST(req({ 'x-cron-secret': 'top-secret' }))
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    const res = await resPromise
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.ok).toBe(false)
  })

  it('never trusts a JSON summary claiming ok:true when the process actually exited non-zero — a real contradiction, not a success', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const resPromise = POST(req({ 'x-cron-secret': 'top-secret' }))
    // A buggy/tampered marker line claims success, but the exit code disagrees.
    child.stdout.push(`PIPELINE_RESULT_JSON:${JSON.stringify({ ok: true, platformSummaries: [] })}\n`)
    child.stdout.push(null)
    setImmediate(() => child.emit('close', 1))
    const res = await resPromise
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(res.status).toBe(207)
  })

  it('never trusts a JSON summary claiming ok:true when the process was killed by a signal (exit code null)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const resPromise = POST(req({ 'x-cron-secret': 'top-secret' }))
    child.stdout.push(`PIPELINE_RESULT_JSON:${JSON.stringify({ ok: true, platformSummaries: [] })}\n`)
    child.stdout.push(null)
    setImmediate(() => child.emit('close', null))
    const res = await resPromise
    const body = await res.json()

    expect(body.ok).toBe(false)
  })

  it('kills the child and reports a clean failure (never hangs, never a fake success) if the pipeline exceeds the timeout', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      child.kill = vi.fn()
      spawnMock.mockReturnValue(child)

      const resPromise = POST(req({ 'x-cron-secret': 'top-secret' }))
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000 + 1)
      const res = await resPromise
      const body = await res.json()

      expect(child.kill).toHaveBeenCalled()
      expect(body.ok).toBe(false)
      expect(res.status).toBe(504)
    } finally {
      vi.useRealTimers()
    }
  })
})
