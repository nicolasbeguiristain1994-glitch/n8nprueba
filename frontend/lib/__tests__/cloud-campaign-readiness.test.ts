/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ query: vi.fn(), permission: vi.fn(), access: vi.fn(), log: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.permission }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.access }))
vi.mock('@/lib/security-log', () => ({ appLog: mocks.log }))

import { GET } from '@/app/api/campaigns/cloud-readiness/route'
import { CLOUD_READINESS_SQL, evaluateCloudReadiness, type CloudReadinessRow } from '@/lib/cloud-api/campaign-readiness'

const NOW = new Date('2026-09-27T15:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const user = { user_id: 'user-1', role: 'operator', is_super_admin: false }
const request = () => new NextRequest('https://example.test/api/campaigns/cloud-readiness')

const row = (over: Partial<CloudReadinessRow> = {}): CloudReadinessRow => ({
  line_id: 'line-1', line_name: 'Solbatt', line_status: 'active', is_connected: true, sending_enabled: true,
  campaign_allowed: true, cloud_number_id: 'cn-1', phone_number_id: '1001', waba_id: '1111', verified_name: 'Solbatt',
  number_status: 'active', has_stored_token: true,
  token_expires_at: new Date(NOW.getTime() + 60 * DAY), last_webhook_at: new Date(NOW.getTime() - DAY),
  approved_template_count: 2,
  ...over,
})
const check = (r: CloudReadinessRow, key: string) => evaluateCloudReadiness(r, NOW).checks.find(c => c.key === key)!

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  mocks.permission.mockResolvedValue({ ok: true, user })
  mocks.access.mockResolvedValue(['line-1'])
  mocks.query.mockResolvedValue([row()])
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('GET /api/campaigns/cloud-readiness — authorization and scope', () => {
  it.each([401, 403])('returns %i before reading lines or the database', async status => {
    mocks.permission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'x' }, { status }) })
    expect((await GET(request())).status).toBe(status)
    expect(mocks.permission).toHaveBeenCalledWith(expect.any(NextRequest), 'campaigns', 'read')
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('scopes a regular user to the accessible line ids on whatsapp_lines', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(mocks.access).toHaveBeenCalledWith(user)
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(CLOUD_READINESS_SQL, [['line-1']])
    expect(CLOUD_READINESS_SQL).toContain('wl.id = ANY($1::uuid[])')
    expect(CLOUD_READINESS_SQL).toContain("wl.line_type = 'cloud'")
    expect(CLOUD_READINESS_SQL).not.toMatch(/wl\.status\s*=|cn\.status\s*=/)
  })

  it('starts from accessible lines and only reaches numbers through their line', () => {
    expect(CLOUD_READINESS_SQL).toMatch(/FROM whatsapp_lines wl\s+LEFT JOIN cloud_numbers cn ON cn\.whatsapp_line_id = wl\.id/)
    expect(CLOUD_READINESS_SQL).not.toMatch(/FROM cloud_numbers|RIGHT JOIN|FULL JOIN/)
  })

  it('passes null for a super administrator so every Cloud line is included', async () => {
    mocks.access.mockResolvedValue(null)
    await GET(request())
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('$1::uuid[] IS NULL'), [null])
  })

  it('passes an empty array (matches nothing) for a user without lines', async () => {
    mocks.access.mockResolvedValue([])
    mocks.query.mockResolvedValue([])
    const res = await GET(request())
    expect(mocks.query).toHaveBeenCalledWith(CLOUD_READINESS_SQL, [[]])
    expect(await res.json()).toMatchObject({ lines: [] })
  })

  it('is read-only, never calls Meta and disables caching', async () => {
    const res = await GET(request())
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(CLOUD_READINESS_SQL.trim()).toMatch(/^SELECT/)
    expect(CLOUD_READINESS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|pgp_sym_decrypt)\b/i)
    expect(fetch).not.toHaveBeenCalled()
    expect(await res.json()).toMatchObject({ source: 'local_database', live_meta_check: false, checked_at: NOW.toISOString() })
  })
})

describe('GET /api/campaigns/cloud-readiness — failures and secrets', () => {
  it('returns 500 with a safe message instead of an empty success on DB errors', async () => {
    mocks.query.mockRejectedValue(new Error('relation "cloud_numbers" does not exist'))
    const res = await GET(request())
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).not.toHaveProperty('lines')
    expect(JSON.stringify(body)).not.toContain('cloud_numbers')
  })

  it('returns 500 when resolving accessible lines fails', async () => {
    mocks.access.mockRejectedValue(new Error('boom'))
    expect((await GET(request())).status).toBe(500)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('only selects a presence boolean for the token, never its value', async () => {
    const presence = "(COALESCE(octet_length(cn.access_token_enc), 0) > 0 OR NULLIF(BTRIM(cn.access_token), '') IS NOT NULL) AS has_stored_token"
    expect(CLOUD_READINESS_SQL).toContain(presence)
    expect(CLOUD_READINESS_SQL.replace(presence, '')).not.toContain('access_token')
  })

  it('does not echo token values even if the driver returned extra columns', async () => {
    mocks.query.mockResolvedValue([{ ...row(), access_token: 'synthetic-secret-token', access_token_enc: 'enc-bytes' }])
    const text = await (await GET(request())).text()
    expect(text).not.toContain('synthetic-secret-token')
    expect(text).not.toContain('enc-bytes')
    expect(text).not.toContain('has_stored_token')
    expect(text).toContain('token_present')
  })

  it('does not log error messages that may contain data', async () => {
    mocks.query.mockRejectedValue(new Error('synthetic-secret-token'))
    await GET(request())
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('synthetic-secret-token')
  })
})

describe('evaluateCloudReadiness — token expiry', () => {
  it('blocks when the token is expired', () => {
    const c = check(row({ token_expires_at: new Date(NOW.getTime() - 1000) }), 'token_expiry')
    expect(c).toMatchObject({ status: 'blocking', detail: 'El token está vencido.' })
  })

  it('warns when the token expires within 7 days', () => {
    const r = evaluateCloudReadiness(row({ token_expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString() }), NOW)
    expect(r.token_expiry_state).toBe('expiring_soon')
    expect(r.checks.find(c => c.key === 'token_expiry')).toMatchObject({ status: 'warning', detail: 'El token vence en 3 días.' })
    expect(r.summary).toBe('warnings')
  })

  it('treats a missing expiry date as unknown, not as never expiring', () => {
    const r = evaluateCloudReadiness(row({ token_expires_at: null }), NOW)
    expect(r.token_expiry_state).toBe('unknown')
    expect(r.checks.find(c => c.key === 'token_expiry')?.status).toBe('warning')
    expect(r.summary).not.toBe('local_checks_complete')
  })

  it('blocks when no token is stored', () => {
    expect(check(row({ has_stored_token: false }), 'token_present').status).toBe('blocking')
  })
})

describe('evaluateCloudReadiness — line state, templates and webhooks', () => {
  it('reports inactive, disconnected and disabled lines as blocking', () => {
    const r = evaluateCloudReadiness(row({ line_status: 'paused', number_status: 'pending', is_connected: false, sending_enabled: false }), NOW)
    expect(r.checks.filter(c => c.status === 'blocking').map(c => c.key)).toEqual(['active', 'connected', 'sending_enabled'])
    expect(r.summary).toBe('blocked')
  })

  it('blocks a line whose allowed types exclude campaigns', () => {
    expect(CLOUD_READINESS_SQL).toContain(
      `(wl.allowed_types IS NULL OR wl.allowed_types @> '["campaign"]'::jsonb) AS campaign_allowed`,
    )
    const r = evaluateCloudReadiness(row({ campaign_allowed: false }), NOW)
    expect(r.checks.find(c => c.key === 'campaign_allowed')).toMatchObject({ status: 'blocking' })
    expect(r.checks.find(c => c.key === 'campaign_allowed')?.detail).toContain('La línea no admite campañas')
    expect(r.summary).toBe('blocked')
    expect(check(row(), 'campaign_allowed').status).toBe('ok')
  })

  it('reports a Cloud line without a linked number without showing null states', () => {
    const r = evaluateCloudReadiness(row({
      cloud_number_id: null, phone_number_id: null, waba_id: null, verified_name: null, number_status: null,
      has_stored_token: false, token_expires_at: null, last_webhook_at: null, approved_template_count: 0,
    }), NOW)
    expect(r).toMatchObject({ number_linked: false, cloud_number_id: null, waba_id: null, approved_template_count: 0, summary: 'blocked' })
    expect(r.checks.find(c => c.key === 'active')).toMatchObject({
      status: 'blocking', detail: 'La línea no tiene un número Cloud vinculado.',
    })
    expect(r.checks.find(c => c.key === 'token_present')?.status).toBe('blocking')
    expect(r.checks.find(c => c.key === 'approved_templates')?.status).toBe('blocking')
    expect(JSON.stringify(r.checks)).not.toMatch(/null|undefined/)
  })

  it('counts only approved templates of the number WABA that carry a Meta ID', () => {
    expect(CLOUD_READINESS_SQL).toMatch(
      /t\.waba_id = cn\.waba_id\s+AND t\.status = 'APROBADA'\s+AND NULLIF\(BTRIM\(t\.whatsapp_template_id\), ''\) IS NOT NULL/,
    )
  })

  it('blocks only template campaigns when there are no approved templates', () => {
    const c = check(row({ approved_template_count: 0 }), 'approved_templates')
    expect(c.status).toBe('blocking')
    expect(c.detail).toContain('campañas con plantilla')
    expect(c.detail).toContain('no evalúa respuestas dentro de la ventana de 24 h')
  })

  it('accepts a positive template count returned by the driver', () => {
    const r = evaluateCloudReadiness(row({ approved_template_count: '3' }), NOW)
    expect(r.approved_template_count).toBe(3)
    expect(r.checks.find(c => c.key === 'approved_templates')?.status).toBe('ok')
  })

  it('never treats an old or missing webhook as a failure', () => {
    for (const last_webhook_at of [new Date(NOW.getTime() - 400 * DAY), null]) {
      const r = evaluateCloudReadiness(row({ last_webhook_at }), NOW)
      expect(r.checks.find(c => c.key === 'last_webhook')?.status).toBe('info')
      expect(r.summary).toBe('local_checks_complete')
    }
  })

  it('never claims the line is ready or that sends are guaranteed', () => {
    const r = evaluateCloudReadiness(row(), NOW)
    expect(r.summary).toBe('local_checks_complete')
    expect(JSON.stringify(r)).not.toMatch(/list[oa]|garantiz/i)
  })
})
