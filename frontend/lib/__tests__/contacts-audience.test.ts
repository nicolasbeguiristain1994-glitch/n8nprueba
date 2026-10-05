import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const q = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({ query: q, getLongRunningClient: async () => ({ query: async () => ({ rows: [] }), end: async () => {} }) }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: vi.fn(async () => ({ ok: true, user: { role: 'admin', user_id: 'test', can_download_contacts: true } })) }))
vi.mock('@/lib/app-settings', () => ({ getAppSetting: async () => true }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { GET } from '@/app/api/contacts/route'
import { contactFilters } from '@/lib/contact-filters'
const criteria = 'tag=prioridad&list_id=11111111-1111-4111-8111-111111111111&segment=vip,medio&actividad=inactivo,perdido&antiguedad=leal&plataforma=zeus&linea=1&linea_sub=a&panel=royal&q=Ana&inactividad_dias=61'
beforeEach(() => { q.mockReset().mockImplementation(async (sql: string) => sql.includes('COUNT(*)') ? [{ count: '0' }] : []) })
describe('Contact audience parity', () => {
  it('uses identical conditions and parameters for list, count and select-all', async () => {
    await GET(new NextRequest(`http://localhost/api/contacts?${criteria}`))
    const main = q.mock.calls[0], count = q.mock.calls[1]
    await GET(new NextRequest(`http://localhost/api/contacts?select_all=true&${criteria}`))
    const selected = q.mock.calls[2]
    const where = (sql: string) => sql.slice(sql.lastIndexOf('FROM contacts WHERE ') + 'FROM contacts WHERE '.length).split(/\s+ORDER BY/)[0].trim()
    expect(where(main[0])).toBe(where(count[0]))
    expect(where(selected[0])).toBe(where(count[0]))
    expect(main[1].slice(0,-2)).toEqual(count[1])
    expect(selected[1]).toEqual(count[1])
    expect(selected[0]).toContain('contact_list_members')
    expect(selected[1]).toContain('prioridad')
    expect(selected[0]).not.toContain('last_activity_at')
  })
  it('returns phones for the same selection used by bulk actions',async()=>{
    q.mockResolvedValue([{ id:'one',phone_number:'+5491111111111' }])
    const res=await GET(new NextRequest('http://localhost/api/contacts?select_all=true'))
    expect(await res.json()).toEqual({ids:['one'],phones:['+5491111111111']})
  })
  it('refuses oversized audiences instead of silently truncating',async ()=>{
    q.mockResolvedValue(Array.from({length:100001},()=>({id:'one',phone_number:'+5491111111111'})))
    const res=await GET(new NextRequest('http://localhost/api/contacts?select_all=true'))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('100.000')
  })
  it('normalizes CSV and repeated segments without dropping a filter',()=>{
    const f=contactFilters(new URLSearchParams('segment=vip, medio&segment=super_vip&actividad=inactivo, perdido'),{role:'admin',user_id:'a'})
    expect(f.params).toEqual([['vip','medio','super_vip'],['inactivo','perdido']])
  })
  it('rejects invalid list IDs rather than broadening the audience',async()=>{
    expect((await GET(new NextRequest('http://localhost/api/contacts?select_all=true&list_id=invalid'))).status).toBe(400)
    expect(q).not.toHaveBeenCalled()
  })
  it('keeps allowed-agent and contact visibility restrictions after all filters',()=>{
    const f=contactFilters(new URLSearchParams(criteria),{role:'operator',user_id:'operator-1',allowed_agents:['royal']})
    expect(f.sql).toContain('operator_contact_visibility')
    expect(f.params.slice(-2)).toEqual(['operator-1',['royal']])
    const indices=[...f.sql.matchAll(/\$(\d+)/g)].map(m=>Number(m[1]))
    expect(Math.max(...indices)).toBe(f.params.length)
  })
})
