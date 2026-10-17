// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), scope: vi.fn(), token: vi.fn(), read: vi.fn(), update: vi.fn(), prepare: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, canAccess: (u: {role:string}) => u.role !== 'viewer' }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.scope }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/cloud-api/profile-photo', async importOriginal => ({ ...await importOriginal<typeof import('../cloud-api/profile-photo')>(), prepareProfilePhoto: mocks.prepare, readProfilePhoto: mocks.read, updateProfilePhoto: mocks.update }))
import { GET, POST } from '@/app/api/lines/[id]/profile-photo/route'
const id = '11111111-1111-4111-8111-111111111111'
const context = { params: Promise.resolve({ id }) }
const line = { id, owner_user_id: 'owner', line_type: 'cloud', phoneNumberId: '123456', wabaId: '234567', cloud_status: 'active' }
function request(file = true) {
  const form = new FormData(); if (file) form.set('file', new Blob(['fixture'], { type: 'image/png' }), 'image.png')
  return new NextRequest('https://app.test/api/lines/' + id + '/profile-photo', { method: 'POST', body: form })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'owner', role: 'operator', sectors: ['lines'] } })
  mocks.scope.mockResolvedValue([id]); mocks.query.mockResolvedValue([line]); mocks.token.mockResolvedValue('private-token')
  mocks.read.mockResolvedValue('https://pps.whatsapp.net/photo.jpg'); mocks.prepare.mockResolvedValue(Buffer.from('prepared'))
  mocks.update.mockResolvedValue({ pictureUrl: 'https://pps.whatsapp.net/new.jpg', refreshPending: false })
})
it('returns only public photo data for an accessible line', async () => {
  const response = await GET(new NextRequest('https://app.test'), context)
  expect(await response.json()).toEqual({ pictureUrl: 'https://pps.whatsapp.net/photo.jpg', canEdit: true })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(mocks.token).toHaveBeenCalledWith('123456')
})
it('updates the owner’s line with the DB-resolved number and safe audit metadata', async () => {
  const response = await POST(request(), context)
  expect(response.status).toBe(200)
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: '123456', wabaId: '234567' }), 'private-token', Buffer.from('prepared'))
  expect(JSON.stringify(await response.json())).not.toContain('private-token')
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: id, metadata: { changedFields: ['profile_picture'], bytes: 8 } }))
})
it('denies an inaccessible line before reading tokens or file contents', async () => {
  mocks.scope.mockResolvedValue([])
  expect((await POST(request(), context)).status).toBe(404)
  expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled()
})
it('permits viewing a granted line, but only its owner or admin may change it', async () => {
  mocks.query.mockResolvedValue([{ ...line, owner_user_id: 'someone-else' }])
  expect((await (await GET(new NextRequest('https://app.test'), context)).json()).canEdit).toBe(false)
  expect((await POST(request(), context)).status).toBe(403)
  expect(mocks.update).not.toHaveBeenCalled()
})
it('allows an administrator to change an accessible line owned by another user', async () => {
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'admin', role: 'admin', is_super_admin: true } }); mocks.scope.mockResolvedValue(null)
  expect((await POST(request(), context)).status).toBe(200)
})
it('honors permission denial before looking up the line', async () => {
  mocks.auth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
  expect((await POST(request(), context)).status).toBe(403)
  expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled()
})
it.each([{ ...line, line_type: 'evolution' }, { ...line, cloud_status: 'suspended' }, { ...line, phoneNumberId: null }])('does not contact Meta for an unsupported connection', async invalid => {
  mocks.query.mockResolvedValue([invalid])
  expect((await POST(request(), context)).status).toBe(409); expect(mocks.token).not.toHaveBeenCalled()
})
it('rejects missing files and oversized actual multipart bodies without a Content-Length', async () => {
  expect((await POST(request(false), context)).status).toBe(400)
  const form = new FormData(); form.set('file', new Blob([new Uint8Array(6*1024*1024)], { type: 'image/png' }), 'large.png')
  const req = new NextRequest('https://app.test', { method: 'POST', body: form })
  expect(req.headers.has('content-length')).toBe(false)
  expect((await POST(req, context)).status).toBe(413)
  expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
})

it('rejects cross-site form submissions before authorization or Meta access', async () => {
  const req = request(); req.headers.set('sec-fetch-site', 'cross-site')
  expect((await POST(req, context)).status).toBe(403)
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled()
})
