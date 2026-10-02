// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/db', () => db)
import { contactRead, ContactReadUnavailableError } from '@/lib/contact-read'
import { GET } from '@/app/api/contacts/route'
import { NextRequest } from 'next/server'
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: async () => ({ ok: true, user: { role: 'admin', user_id: 'test', can_download_contacts: true } }) }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/app-settings', () => ({ getAppSetting: async () => true }))
vi.mock('@/lib/contact-filters', () => ({ resolvedContactFilters: async () => ({sql:'deleted_at IS NULL',params:[]}), ContactFilterError: class extends Error {} }))
beforeEach(() => vi.resetAllMocks())
describe('Contact read timeout recovery', () => {
  it('returns a successful read without retrying', async () => {
    db.query.mockResolvedValueOnce([{id:'one'}])
    expect(await contactRead('SELECT id FROM contacts')).toEqual([{id:'one'}])
    expect(db.query).toHaveBeenCalledTimes(1)
  })
  it('recovers the default page after the observed query read timeout', async () => {
    db.query.mockRejectedValueOnce(new Error('Query read timeout')).mockResolvedValueOnce([{id:'one'}]).mockResolvedValueOnce([{count:'225328'}])
    const response = await GET(new NextRequest('http://localhost/api/contacts'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({contacts:[{id:'one'}],total:225328,page:1,limit:50})
    expect(db.query.mock.calls[1]).toEqual(db.query.mock.calls[0])
    expect(db.query).toHaveBeenCalledTimes(3)
  })
  it('recovers a count cancelled by PostgreSQL statement timeout', async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'})).mockResolvedValueOnce([{count:'5'}])
    expect(await contactRead('SELECT COUNT(*) FROM contacts')).toEqual([{count:'5'}])
  })
  it('stops after one retry and returns a retryable 503', async () => {
    db.query.mockRejectedValue(new Error('Query read timeout'))
    const response = await GET(new NextRequest('http://localhost/api/contacts'))
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('3')
    expect((await response.json()).error).toContain('Volvé a intentar')
    expect(db.query).toHaveBeenCalledTimes(2)
  })
  it('does not retry SQL errors or explicit query cancellations', async () => {
    const error=Object.assign(new Error('canceling statement due to user request'),{code:'57014'})
    db.query.mockRejectedValue(error)
    await expect(contactRead('SELECT id FROM contacts')).rejects.toBe(error)
    expect(db.query).toHaveBeenCalledTimes(1)
  })
  it('reports a different failure during retry without hiding it', async () => {
    const error=new Error('permission denied')
    db.query.mockRejectedValueOnce(new Error('Query read timeout')).mockRejectedValueOnce(error)
    await expect(contactRead('SELECT id FROM contacts')).rejects.toBe(error)
    expect(error).not.toBeInstanceOf(ContactReadUnavailableError)
    expect(db.query).toHaveBeenCalledTimes(2)
  })
})
