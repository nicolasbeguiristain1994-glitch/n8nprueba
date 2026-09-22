// @vitest-environment node
/**
 * test-casino-sync-route.test.ts
 *
 * Regression tests for GET /api/admin/test-casino-sync (fase 4 audit fix):
 * the route used to ALWAYS respond `ok: true` regardless of the child
 * process's real exit code or a timeout, and spawned a bare "node" off
 * $PATH instead of process.execPath. Both are fixed:
 *   - ok is true only when the child exits with code 0
 *   - a non-zero exit code, a timeout, or a spawn error all report ok:false
 *   - an invalid platform is rejected with 400 before anything spawns
 *   - the child is spawned via process.execPath, not a bare "node"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))

const spawnMock = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))
vi.mock('fs', () => ({ default: { existsSync: () => true }, existsSync: () => true }))

import * as permissions from '@/lib/permissions'
import { GET } from '@/app/api/admin/test-casino-sync/route'

type FakeChild = EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void }

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.kill = vi.fn()
  return child
}

function req(url: string) {
  return new NextRequest(new Request(url))
}

describe('GET /api/admin/test-casino-sync', () => {
  beforeEach(() => {
    vi.mocked(permissions.checkPermission).mockResolvedValue(undefined as never)
    spawnMock.mockReset()
  })

  it('rejects an invalid platform with 400, never spawning a process', async () => {
    const res = await GET(req('http://x/api/admin/test-casino-sync?platform=nope'))
    expect(res.status).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns via process.execPath, never a bare "node" off $PATH', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const resPromise = GET(req('http://x/api/admin/test-casino-sync?platform=zeus'))
    queueMicrotask(() => child.emit('close', 0))
    await resPromise
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath)
  })

  it('reports ok:true only when the child exits with code 0', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const resPromise = GET(req('http://x/api/admin/test-casino-sync?platform=zeus'))
    queueMicrotask(() => child.emit('close', 0))
    const res = await resPromise
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('reports ok:false (never true) when the child exits with a non-zero code', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const resPromise = GET(req('http://x/api/admin/test-casino-sync?platform=zeus'))
    queueMicrotask(() => child.emit('close', 1))
    const res = await resPromise
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(res.status).toBe(502)
    expect(body.output.code).toBe(1)
  })

  it('reports ok:false when the process never even started (spawn error, e.g. ENOENT)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const resPromise = GET(req('http://x/api/admin/test-casino-sync?platform=zeus'))
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    const res = await resPromise
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.output.spawnError).toMatch(/ENOENT/)
  })
})
