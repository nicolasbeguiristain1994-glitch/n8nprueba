import { describe,it,expect,vi,beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
const q=vi.hoisted(()=>vi.fn(async()=>[]))
vi.mock('@/lib/db',()=>({query:q}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:vi.fn(async()=>({ok:true,user:{role:'admin',user_id:'test',can_download_contacts:true}}))}))
vi.mock('@/lib/contact-visibility',()=>({visibilityClause:()=>({sql:'',params:[]})}))
vi.mock('@/lib/app-settings',()=>({getAppSetting:async()=>true}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
import {GET as contacts} from '@/app/api/contacts/route'
import {GET as exported} from '@/app/api/contacts/segment-export/route'
beforeEach(()=>q.mockClear())
describe('Platform audience filters',()=>{
 for(const platform of ['ganamos','argenbet']) for(const [name,handler,path] of [['selection',contacts,'/api/contacts?select_all=true&'],['export',exported,'/api/contacts/segment-export?']] as const){
  it(`${name} accepts and filters ${platform}`,async()=>{
   const res=await handler(new NextRequest(`http://localhost${path}plataforma=${platform}`))
   expect(res.status).toBe(200)
   expect(q.mock.calls.flat().join(' ')).toContain(`'${platform}' = ANY(contacts.platforms)`)
  })
 }
 it('otros excludes all supported platforms',async()=>{
  await contacts(new NextRequest('http://localhost/api/contacts?select_all=true&plataforma=otros'))
  expect(q.mock.calls.flat().join(' ')).toContain("ARRAY['zeus','bet30','ganamos','argenbet']")
 })
})
