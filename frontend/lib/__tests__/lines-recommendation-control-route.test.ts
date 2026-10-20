// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), scope: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.scope, lineVisibilityClause: () => ({ clause: '', params: [] }) }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
import { GET, PATCH } from '@/app/api/lines/route'
const id = '11111111-1111-4111-8111-111111111111'
const request = (body: unknown) => new NextRequest('https://app.test/api/lines', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const updates = () => mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE whatsapp_lines'))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'owner', role: 'operator' } })
  mocks.scope.mockResolvedValue([id])
  mocks.query.mockImplementation(async (sql: string) => sql.startsWith('SELECT owner_user_id') ? [{ owner_user_id: 'owner' }] : [{ id, respect_daily_recommendation: false }])
})
it('returns the persisted disabled setting with the scoped line list', async () => {
  const response = await GET(new NextRequest('https://app.test/api/lines'))
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(NextRequest), 'lines', 'read')
  expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('FROM whatsapp_lines l'))?.[0]).toContain('l.respect_daily_recommendation')
  expect(await response.json()).toMatchObject({ lines: [{ id, respect_daily_recommendation: false }] })
})
it.each([true, false])('allows the owner to persist %s without changing sending_enabled', async enabled => {
  const response = await PATCH(request({ id, respect_daily_recommendation: enabled }))
  expect(response.status).toBe(200)
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(NextRequest), 'lines', 'update')
  expect(updates()).toEqual([[expect.stringContaining('respect_daily_recommendation = $1'), [enabled, id]]])
  expect(updates()[0][0]).not.toContain('sending_enabled')
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: id, metadata: { changedFields: ['respect_daily_recommendation'], respect_daily_recommendation: enabled } }))
})
it.each([null, 'true', 'false', 0, 1, {}, []])('rejects a non-boolean %j before looking up or modifying a line', async value => {
  expect((await PATCH(request({ id, respect_daily_recommendation: value }))).status).toBe(400)
  expect(mocks.query).not.toHaveBeenCalled()
})
it('preserves the setting when omitted by an existing client', async () => {
  expect((await PATCH(request({ id, display_name: 'Updated' }))).status).toBe(200)
  expect(updates()[0][0]).not.toContain('respect_daily_recommendation')
  expect(updates()[0][1]).toEqual(['Updated', id])
})
it('denies a user without lines:update before any scope or database access', async () => {
  mocks.auth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
  expect((await PATCH(request({ id, respect_daily_recommendation: true }))).status).toBe(403)
  expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled()
})
it('does not allow an operator to change a granted line owned by another user', async () => {
  mocks.query.mockResolvedValue([{ owner_user_id: 'another-owner' }])
  expect((await PATCH(request({ id, respect_daily_recommendation: true }))).status).toBe(403)
  expect(updates()).toHaveLength(0)
})
it('does not allow the control to bypass the administrator-only kill switch', async () => {
  expect((await PATCH(request({ id, respect_daily_recommendation: true, sending_enabled: true }))).status).toBe(403)
  expect(updates()).toHaveLength(0)
})
it('requires an accessible line even for an administrator', async () => {
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'admin', role: 'admin' } })
  mocks.scope.mockResolvedValue([])
  expect((await PATCH(request({ id, respect_daily_recommendation: true }))).status).toBe(404)
  expect(updates()).toHaveLength(0)
  mocks.scope.mockResolvedValue([id])
  expect((await PATCH(request({ id, respect_daily_recommendation: true }))).status).toBe(200)
  expect(updates()).toHaveLength(1)
})
it('returns not found rather than reporting a successful update of a missing line', async () => {
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'admin', role: 'admin', is_super_admin: true } })
  mocks.scope.mockResolvedValue(null); mocks.query.mockResolvedValue([])
  expect((await PATCH(request({ id, respect_daily_recommendation: true }))).status).toBe(404)
  expect(mocks.audit).not.toHaveBeenCalled()
})
