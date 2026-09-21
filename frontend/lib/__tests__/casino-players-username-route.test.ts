// @vitest-environment node
/**
 * casino-players-username-route.test.ts
 *
 * Regression tests for PATCH /api/dashboard/casino/players/[username] (fase 1,
 * bloqueante mensaje 7 punto 2): la mutación de labels ya no puede afectar más
 * de una fila. `platform` es obligatorio, `consolidado` se rechaza como
 * destino, y los 400 no deben ejecutar ningún UPDATE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const queryMock = vi.fn()
vi.mock('@/lib/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))

import * as permissions from '@/lib/permissions'
import { PATCH } from '@/app/api/dashboard/casino/players/[username]/route'

function req(url: string, body: unknown) {
  return new NextRequest(new Request(url, { method: 'PATCH', body: JSON.stringify(body) }))
}

function params(username: string) {
  return { params: Promise.resolve({ username }) }
}

describe('PATCH /api/dashboard/casino/players/[username]', () => {
  beforeEach(() => {
    queryMock.mockReset()
    vi.mocked(permissions.checkPermission).mockResolvedValue(undefined as never)
  })

  it('rejects a missing platform with 400 and never queries the DB', async () => {
    const res = await PATCH(
      req('http://x/api/dashboard/casino/players/bigwin', { labels: ['vip'] }),
      params('bigwin'),
    )
    expect(res.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('rejects "consolidado" as a mutation target with 400 and never queries the DB', async () => {
    const res = await PATCH(
      req('http://x/api/dashboard/casino/players/bigwin?platform=consolidado', { labels: ['vip'] }),
      params('bigwin'),
    )
    expect(res.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid platform with 400 and never queries the DB', async () => {
    const res = await PATCH(
      req('http://x/api/dashboard/casino/players/bigwin?platform=nope', { labels: ['vip'] }),
      params('bigwin'),
    )
    expect(res.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('with a valid platform, updates only that (platform, username_lower) row', async () => {
    queryMock.mockResolvedValueOnce([{ labels: ['vip'], platform: 'zeus' }])
    const res = await PATCH(
      req('http://x/api/dashboard/casino/players/bigwin?platform=zeus', { labels: ['vip'] }),
      params('bigwin'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.platform).toBe('zeus')

    const [sql, sqlParams] = queryMock.mock.calls[0]
    expect(sql).toContain('platform = $3')
    expect(sql).not.toContain('$3::text IS NULL')
    expect(sqlParams).toEqual([['vip'], 'bigwin', 'zeus'])
  })

  it('404s when the (platform, username) pair does not exist, without touching other platforms', async () => {
    queryMock.mockResolvedValueOnce([])
    const res = await PATCH(
      req('http://x/api/dashboard/casino/players/bigwin?platform=bet30', { labels: ['vip'] }),
      params('bigwin'),
    )
    expect(res.status).toBe(404)
  })
})
