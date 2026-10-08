// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: vi.fn() }))
vi.mock('@/lib/app-settings', () => ({ getAppSetting: vi.fn() }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/missing-contacts', async original => {
  const actual = await original<typeof import('@/lib/missing-contacts')>()
  return { ...actual, listMissingContacts: vi.fn(), importMissingContacts: vi.fn() }
})
vi.mock('@/lib/db', () => ({ getLongRunningClient: vi.fn(), pool: { query: vi.fn() } }))
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAppSetting } from '@/lib/app-settings'
import { listMissingContacts, importMissingContacts } from '@/lib/missing-contacts'
import { GET } from '@/app/api/contacts/missing-phone/route'
import { POST } from '@/app/api/contacts/missing-phone/import/route'
import { parseMissingContactSheet } from '@/lib/missing-contact-files'
const request = (s='') => new NextRequest(`http://localhost/api/contacts/missing-phone?${s}`)
const row = { row:2,username:'test',platform:'zeus',agent:'royal',phone:'+5491123456789',name:'' }
const post = (body: unknown) => new NextRequest('http://localhost/api/contacts/missing-phone/import',{ method:'POST',body:JSON.stringify(body) })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(checkPermissionWithUser).mockResolvedValue({ ok:true,user:{role:'admin',user_id:'admin',allowed_agents:[],can_download_contacts:true} } as never)
  vi.mocked(getAppSetting).mockResolvedValue(true)
  vi.mocked(listMissingContacts).mockResolvedValue({ users:[{username:'=test',platform:'zeus',agent:'royal',source_agent:'royal',last_movement:'2026-10-01',first_seen_at:null}],total:1,agents:['royal'] })
})

it('requires read permission for list, export and import', async () => {
  vi.mocked(checkPermissionWithUser).mockResolvedValue({ ok:false,response:NextResponse.json({error:'denied'},{status:403}) })
  expect((await GET(request())).status).toBe(403)
  expect((await GET(request('download=true'))).status).toBe(403)
  expect((await POST(post({rows:[row],dryRun:false}))).status).toBe(403)
  expect(listMissingContacts).not.toHaveBeenCalled(); expect(importMissingContacts).not.toHaveBeenCalled()
})

it('enforces global and per-user export restrictions', async () => {
  vi.mocked(getAppSetting).mockResolvedValue(false)
  expect((await GET(request('download=true'))).status).toBe(403)
  vi.mocked(getAppSetting).mockResolvedValue(true)
  vi.mocked(checkPermissionWithUser).mockResolvedValue({ok:true,user:{can_download_contacts:false}} as never)
  expect((await GET(request('download=true'))).status).toBe(403)
  expect(listMissingContacts).not.toHaveBeenCalled()
})

it('exports a safe, reusable Excel sheet and applies the requested filters', async () => {
  const response = await GET(request('download=true&months=6&agent=royal&platform=zeus'))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('spreadsheetml')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(listMissingContacts).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({months:6,agent:'royal',platform:'zeus'}),true)
  const book = XLSX.read(await response.arrayBuffer(),{type:'array',cellNF:true})
  const sheet = book.Sheets['Usuarios sin número']
  expect(sheet.A2.f).toBeUndefined(); expect(sheet.A2.v).toBe('=test')
  expect(sheet.E2.z).toBe('@')
  sheet.E2={t:'s',v:'+5491123456789',z:'@'}
  expect(parseMissingContactSheet(XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:false}))[0]).toMatchObject({username:'=test',phone:'+5491123456789'})
})

it('validates requests and never imports until dryRun is explicitly false', async () => {
  expect((await GET(request('months=-1'))).status).toBe(400)
  expect((await POST(post({rows:[row]}))).status).toBe(400)
  expect((await POST(post({rows:null,dryRun:false}))).status).toBe(400)
  expect(importMissingContacts).not.toHaveBeenCalled()
  vi.mocked(importMissingContacts).mockResolvedValue({ total:1,ready:1,inserted:0,linked:0,blank:0,errors:[],unchanged:0,dryRun:true })
  expect((await POST(post({rows:[row],dryRun:true}))).status).toBe(200)
  expect(importMissingContacts).toHaveBeenCalledWith(expect.anything(),[row],true)
  expect(checkPermissionWithUser).toHaveBeenCalledWith(expect.anything(),'contacts','create')
  expect(checkPermissionWithUser).toHaveBeenCalledWith(expect.anything(),'contacts','read')
})
