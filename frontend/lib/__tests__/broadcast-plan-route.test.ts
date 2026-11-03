/** @vitest-environment node */
import { beforeEach,it,expect,vi } from 'vitest'
import { NextRequest,NextResponse } from 'next/server'
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:vi.fn()}))
vi.mock('@/lib/broadcast-plan-repository',()=>({getBroadcastPlanningOptions:vi.fn(),prepareDailyBroadcast:vi.fn(),BroadcastPlanError:class extends Error{constructor(message:string,public status=400){super(message)}}}))
import { checkPermissionWithUser } from '@/lib/permissions'
import { getBroadcastPlanningOptions,prepareDailyBroadcast,BroadcastPlanError } from '@/lib/broadcast-plan-repository'
import { GET,POST } from '@/app/api/contacts/prioritized/plan/route'
const body={lineIds:['11111111-1111-4111-8111-111111111111'],messageType:'text',endTime:'20:00',reservePercent:10,maxContacts:500}
const req=(data:unknown=body)=>new NextRequest('http://localhost/api/contacts/prioritized/plan',{method:'POST',body:JSON.stringify(data)})
beforeEach(()=>{vi.resetAllMocks();vi.mocked(checkPermissionWithUser).mockResolvedValue({ok:true,user:{user_id:'actor'}} as never)})
it('requires priorities, campaign creation and line read permissions before loading data',async()=>{
  vi.mocked(checkPermissionWithUser).mockResolvedValueOnce({ok:true,user:{user_id:'actor'}} as never).mockResolvedValueOnce({ok:false,response:NextResponse.json({error:'Forbidden'},{status:403})})
  expect((await GET(req())).status).toBe(403)
  expect(checkPermissionWithUser).toHaveBeenNthCalledWith(1,expect.anything(),'priorities','read')
  expect(getBroadcastPlanningOptions).not.toHaveBeenCalled()
  expect(checkPermissionWithUser).toHaveBeenNthCalledWith(2,expect.anything(),'campaigns','create')
})
it('rejects malformed limits, unknown fields and missing template before querying',async()=>{
  for(const data of [{...body,reservePercent:-1},{...body,maxContacts:5001},{...body,endTime:'25:00'},{...body,ownerId:'another'},{...body,messageType:'template'},{...body,lineIds:[]}])
    expect((await POST(req(data))).status).toBe(400)
  expect(prepareDailyBroadcast).not.toHaveBeenCalled()
})
it('uses the authenticated owner and returns an uncached preview',async()=>{
  vi.mocked(prepareDailyBroadcast).mockResolvedValue({selected:4} as never)
  const response=await POST(req({...body,platform:'zeus',agent:'royal'}))
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store')
  expect(prepareDailyBroadcast).toHaveBeenCalledWith({user_id:'actor'},expect.objectContaining({platform:'zeus',agent:'royal'}))
})
it('reports domain failures and hides database error details',async()=>{
  vi.mocked(prepareDailyBroadcast).mockRejectedValueOnce(new BroadcastPlanError('Sin cálculo completo',409)).mockRejectedValueOnce(Error('private database detail'))
  expect((await POST(req())).status).toBe(409)
  const response=await POST(req());expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('private database detail')
})
