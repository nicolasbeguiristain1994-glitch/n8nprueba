// @vitest-environment node
/**
 * casino-sync-route.test.ts
 *
 * Regression tests for POST /api/dashboard/casino/sync (fase 1, H4 + review
 * fixes):
 *   - the 4 platforms are recognized (zeus/bet30/ganamos/argenbet), not just
 *     zeus/bet30 — before this fix, ganamos/argenbet crashed with a raw
 *     TypeError instead of a clean 503.
 *   - each platform's credential model is checked correctly (Zeus/Bet30:
 *     apiKey+token or apiKey+admin; Argenbet: bearer token or admin;
 *     Ganamos: at least one per-agent user/password pair).
 *   - desde/hasta are validated as real calendar dates, and desde <= hasta —
 *     otherwise sync-casino-players-live.js can silently no-op with exit 0.
 *   - the supervisor is spawned with an argument array (never a shell string):
 *     query params must not be interpolated into a shell command.
 *   - a spawn failure (async 'error' event, e.g. ENOENT) must not be reported
 *     as a successful launch.
 *   - pending fix: a config/credential failure (503) or a spawn failure (500)
 *     — cases where the child process never gets to run and so can never
 *     write its own row — must leave a 'failed' platform-level row (agente
 *     NULL) in casino_sync_runs, with a safe hint/message (env var NAMES,
 *     never values). Auth/input rejections (403/400) must NOT write anything
 *     — those aren't real sync failures.
 *   - an `agentes` override is validated against getAgentsForPlatform(platform)
 *     — an agent name from a different platform is rejected with 400 before
 *     ever reaching spawn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { EventEmitter } from 'events'

vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSessionFromRequest: vi.fn() }))

const spawnMock = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const queryMock = vi.fn()
vi.mock('@/lib/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }))

import * as permissions from '@/lib/permissions'
import * as auth        from '@/lib/auth'
import { POST } from '@/app/api/dashboard/casino/sync/route'

// spawnAndConfirm() in the route awaits either the 'spawn' or 'error' event
// before resolving — the fake child must emit one of those, not 'exit'.
function makeFakeChild({ willError }: { willError?: Error } = {}) {
  const child = new EventEmitter() as EventEmitter & { unref: () => void; pid: number }
  child.unref = vi.fn()
  child.pid = 4242
  queueMicrotask(() => {
    if (willError) child.emit('error', willError)
    else child.emit('spawn')
  })
  return child
}

function req(url: string) {
  return new NextRequest(new Request(url))
}

const ENV_KEYS = [
  'DATABASE_URL', 'ZEUS_API_KEY', 'ZEUS_PLAYER_TOKEN', 'ZEUS_ADMIN_USER', 'ZEUS_ADMIN_PASSWORD',
  'BET30_API_KEY', 'BET30_PLAYER_TOKEN', 'BET30_ADMIN_USER', 'BET30_ADMIN_PASSWORD',
  'ARGENBET_PLAYER_TOKEN', 'ARGENBET_ADMIN_USER', 'ARGENBET_ADMIN_PASSWORD',
  'GANAMOS_ADMINBTC_USER', 'GANAMOS_ADMINBTC_PASSWORD',
]

describe('POST /api/dashboard/casino/sync', () => {
  beforeEach(() => {
    vi.mocked(permissions.checkPermission).mockResolvedValue(undefined as never)
    vi.mocked(auth.getSessionFromRequest).mockReturnValue({ role: 'admin' } as never)
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeChild())
    queryMock.mockReset()
    queryMock.mockResolvedValue([])
    process.env.DATABASE_URL = 'postgresql://fixture.invalid/test'
    process.env.ZEUS_API_KEY = 'key'
    process.env.ZEUS_PLAYER_TOKEN = 'token'
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it('rejects a missing database configuration and records the failure when possible', async () => {
    delete process.env.DATABASE_URL
    const res = await POST(req('http://x/api/dashboard/casino/sync'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('DATABASE_URL')
    expect(queryMock).toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an end date without a start and an empty agent list before recording a sync', async () => {
    for (const query of ['hasta=2026-09-21', 'agentes=,,']) {
      const res = await POST(req(`http://x/api/dashboard/casino/sync?${query}`))
      expect(res.status).toBe(400)
    }
    expect(queryMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid platform with 400 listing all 4 valid values', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=nope'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('zeus, bet30, ganamos, argenbet')
  })

  it('zeus/bet30 without any credential configured → 503, no process spawned', async () => {
    delete process.env.ZEUS_API_KEY
    delete process.env.ZEUS_PLAYER_TOKEN
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus'))
    expect(res.status).toBe(503)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('argenbet with only ARGENBET_PLAYER_TOKEN set → accepted (H4: no longer a TypeError)', async () => {
    process.env.ARGENBET_PLAYER_TOKEN = 'jwt-token'
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=argenbet'))
    expect(res.status).toBe(202)
    expect(spawnMock).toHaveBeenCalled()
  })

  it('argenbet with no credentials at all → 503 with a hint mentioning ARGENBET_PLAYER_TOKEN', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=argenbet'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('ARGENBET_PLAYER_TOKEN')
  })

  it('ganamos with one agent configured (out of 6) → accepted', async () => {
    process.env.GANAMOS_ADMINBTC_USER     = 'user'
    process.env.GANAMOS_ADMINBTC_PASSWORD = 'pass'
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=ganamos'))
    expect(res.status).toBe(202)
  })

  it('ganamos with zero agents configured → 503 with a per-agent hint', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=ganamos'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('GANAMOS_<AGENTE>_USER')
  })

  it('rejects a malformed desde with 400 (never reaches spawn)', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&desde=not-a-date'))
    expect(res.status).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a non-existent calendar date (e.g. 2025-02-30) with 400', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&desde=2025-02-30'))
    expect(res.status).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects desde > hasta with 400 (would otherwise silently no-op with exit 0)', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&desde=2025-02-01&hasta=2025-01-01'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/no puede ser posterior/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns ONE supervisor process with an argument array — no shell, no string interpolation', async () => {
    await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&agentes=betcoin,royal'))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = spawnMock.mock.calls[0]
    expect(cmd).toBe(process.execPath) // never 'sh', never a bare 'node' off $PATH
    expect(Array.isArray(args)).toBe(true)
    expect(args[0]).toMatch(/casino-sync-then-segment\.js$/)
    expect(args).toContain('--')
    // the payload survives as ONE argv entry, never parsed by a shell
    expect(args.some((a: string) => a === '--agentes=betcoin,royal')).toBe(true)
  })

  it('rejects a shell-injection-shaped agentes value with 400 — it fails the platform allowlist and never reaches spawn', async () => {
    // Since agentes is now validated against getAgentsForPlatform(), a payload
    // like this can't survive as an argv entry anymore — it's rejected before
    // spawn is ever called, not merely defused at the spawn() call itself.
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&agentes=betcoin;rm -rf /'))
    expect(res.status).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('waits for the spawn to actually start before responding — a spawn error (ENOENT) is a 500, not a fake 200', async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild({ willError: new Error('spawn ENOENT') }))
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus'))
    expect(res.status).toBe(500)
  })

  it('rejects an agent from a different platform with 400, before ever calling spawn or writing to casino_sync_runs', async () => {
    // 'btcuno' only exists under bet30 — using it against zeus must be rejected.
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&agentes=betcoin,btcuno'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('btcuno')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('accepts agentes that all belong to the requested platform', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&agentes=betcoin,royal'))
    expect(res.status).toBe(202)
  })

  it('a missing-credentials 503 records a failed platform-level run in casino_sync_runs with a safe hint (no secret values)', async () => {
    delete process.env.ZEUS_API_KEY
    delete process.env.ZEUS_PLAYER_TOKEN
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus'))
    expect(res.status).toBe(503)

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('INSERT INTO casino_sync_runs')
    expect(sql).toContain("'failed'")
    expect(params[0]).toBe('zeus')
    // the recorded error is the credential hint (env var NAMES), never a value
    expect(params[3]).toContain('ZEUS_API_KEY')
    expect(params[3]).not.toContain('key')
  })

  it('an invalid platform (400) never writes to casino_sync_runs — not a real sync failure', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=nope'))
    expect(res.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('a forbidden non-admin request (403) never writes to casino_sync_runs', async () => {
    vi.mocked(auth.getSessionFromRequest).mockReturnValue({ role: 'operator' } as never)
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus'))
    expect(res.status).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('an invalid desde/hasta (400) never writes to casino_sync_runs', async () => {
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus&desde=not-a-date'))
    expect(res.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('a spawn failure (500) also records a failed platform-level run', async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild({ willError: new Error('spawn ENOENT') }))
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus'))
    expect(res.status).toBe(500)

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('INSERT INTO casino_sync_runs')
    expect(params[0]).toBe('zeus')
    expect(params[3]).toContain('ENOENT')
  })

  it('if casino_sync_runs itself is unreachable, the original 503 is still returned — no fake success is invented', async () => {
    delete process.env.ZEUS_API_KEY
    delete process.env.ZEUS_PLAYER_TOKEN
    queryMock.mockRejectedValueOnce(new Error('connection refused'))
    const res = await POST(req('http://x/api/dashboard/casino/sync?platform=zeus'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('ZEUS_API_KEY')
  })
})
