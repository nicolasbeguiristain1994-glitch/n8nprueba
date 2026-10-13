// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const m = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: m.auth }))
vi.mock('@/lib/db', () => ({ query: m.query }))
vi.mock('@/lib/audit', () => ({ audit: m.audit }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
import { GET, PATCH, DELETE } from '@/app/api/automations/[id]/route'
import { GET as list } from '@/app/api/automations/route'
import { PATCH as settingsPatch } from '@/app/api/settings/route'
import { OPT_OUT_AUTOMATION, OPT_OUT_MESSAGE_SETTING } from '@/lib/opt-out-automation'

const userId = '00000000-0000-4000-8000-000000000001'
const params = { params: Promise.resolve({ id: OPT_OUT_AUTOMATION.id }) }
const request = (method = 'GET', body?: unknown, search = '') => new NextRequest(`http://localhost/api/automations/${OPT_OUT_AUTOMATION.id}${search}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
})
beforeEach(() => {
  vi.resetAllMocks()
  m.auth.mockResolvedValue({ ok: true, user: { user_id: userId } })
  m.query.mockResolvedValue([])
})

it('saves only the message with manage permission, preserving the always-active BAJA trigger', async () => {
  m.query.mockResolvedValue([{ value: 'Perdón por las molestias. Registramos tu baja.', updated_at: '2026-10-13T20:00:00Z' }])
  const response = await PATCH(request('PATCH', { action_config: { message: '  Perdón por las molestias. Registramos tu baja.  ' } }), params)
  expect(response.status).toBe(200)
  expect(m.auth).toHaveBeenCalledWith(expect.anything(), 'automations', 'manage')
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT(key)'), [OPT_OUT_MESSAGE_SETTING, JSON.stringify('Perdón por las molestias. Registramos tu baja.'), userId])
  expect((await response.json()).automation).toMatchObject({ is_active: true, trigger_config: { keywords: ['BAJA'] }, action_config: { message: 'Perdón por las molestias. Registramos tu baja.' } })
  expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', metadata: { system_automation_id: OPT_OUT_AUTOMATION.id, fields: ['action_config.message'] } }))
})

it.each([{}, null, { action_config: { message: '  ' } }, { action_config: { message: 1 } },
  { action_config: { message: 'x'.repeat(4097) } }, { action_config: { message: 'Baja', arbitrary: true } },
  { action_config: { message: 'Baja' }, is_active: false }, { trigger_config: { keywords: ['EXTRA'] } },
])('rejects invalid text and changes to system behavior: %j', async body => {
  expect((await PATCH(request('PATCH', body), params)).status).toBe(400)
  expect(m.query).not.toHaveBeenCalled()
})

it('requires permissions before reading or writing and never deletes the system automation', async () => {
  m.auth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
  expect((await PATCH(request('PATCH', { action_config: { message: 'Baja' } }), params)).status).toBe(403)
  expect((await GET(request(), params)).status).toBe(403)
  expect(m.query).not.toHaveBeenCalled()
  m.auth.mockResolvedValue({ ok: true, user: { user_id: userId } })
  expect((await DELETE(request('DELETE'), params)).status).toBe(400)
  expect(m.query).not.toHaveBeenCalled()
})

it('returns the stored text in both detail and filtered list, and keeps paused lists unchanged', async () => {
  m.query.mockImplementation(async (sql: string) => sql.includes('app_settings') ? [{ value: 'Texto guardado', updated_at: '2026-10-13T20:00:00Z' }] : [])
  expect((await (await GET(request(), params)).json()).automation.action_config.message).toBe('Texto guardado')
  const rows = (await (await list(request('GET', undefined, '?q=baja&status=active'))).json()).automations
  expect(rows).toHaveLength(1)
  expect(rows[0].action_config.message).toBe('Texto guardado')
  expect((await (await list(request('GET', undefined, '?status=paused'))).json()).automations).toEqual([])
})

it('cannot bypass message validation and automation permissions through general settings', async () => {
  expect((await settingsPatch(request('PATCH', { [OPT_OUT_MESSAGE_SETTING]: '' }))).status).toBe(400)
  expect(m.query).not.toHaveBeenCalled()
})

it('reports a failed save instead of presenting the default as saved', async () => {
  m.query.mockRejectedValueOnce(new Error('Database unavailable'))
  expect((await PATCH(request('PATCH', { action_config: { message: 'Baja' } }), params)).status).toBe(500)
})
