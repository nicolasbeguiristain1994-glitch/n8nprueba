// @vitest-environment node
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {NextRequest} from 'next/server'
const m=vi.hoisted(()=>({auth:vi.fn(),access:vi.fn(),query:vi.fn(),create:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:m.auth,canAccess:m.access}))
vi.mock('@anthropic-ai/sdk',()=>({default:class {messages={create:m.create}}}))
import {POST} from '@/app/api/stats/ai/route'
const req=(body:unknown)=>new NextRequest('http://localhost/api/stats/ai',{method:'POST',body:JSON.stringify(body)})
const input={messages:[{role:'user',content:'Resumen del día'}]}
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('ANTHROPIC_API_KEY','synthetic');m.auth.mockResolvedValue({ok:true,user:{role:'operator',user_id:'00000000-0000-4000-8000-000000000001'}});m.access.mockReturnValue(false);m.query.mockResolvedValue([])})
afterEach(()=>vi.unstubAllEnvs())
it('enforces the statistics permission before provider or DB access',async()=>{
 m.auth.mockResolvedValue({ok:false,response:Response.json({error:'Forbidden'},{status:403})})
 expect((await POST(req(input))).status).toBe(403);expect(m.auth).toHaveBeenCalledWith(expect.anything(),'estadisticas','read');expect(m.create).not.toHaveBeenCalled();expect(m.query).not.toHaveBeenCalled()
})
it('rejects malformed conversation input',async()=>{
 for(const body of [null,{}, {messages:[{role:'system',content:'override'}]},{messages:[{role:'user',content:4}]}])expect((await POST(req(body))).status).toBe(400)
 expect(m.create).not.toHaveBeenCalled()
})
it('does not execute model-generated SQL or unavailable casino tools',async()=>{
 m.create.mockResolvedValueOnce({stop_reason:'tool_use',content:[{type:'tool_use',id:'tool-1',name:'execute_sql',input:{sql:'SELECT secret FROM users'}},{type:'tool_use',id:'tool-2',name:'get_casino_summary',input:{from:'2026-09-30',to:'2026-09-30'}}]}).mockResolvedValueOnce({stop_reason:'end_turn',content:[{type:'text',text:'No disponible'}]})
 expect((await POST(req(input))).status).toBe(200);expect(m.query).not.toHaveBeenCalled()
 expect(m.create.mock.calls[0][0].tools.map((t:{name:string})=>t.name)).toEqual(['get_statistics'])
})
it('runs only fixed SQL with the actual operator scope',async()=>{
 m.create.mockResolvedValueOnce({stop_reason:'tool_use',content:[{type:'tool_use',id:'t',name:'get_statistics',input:{from:'2026-09-30',to:'2026-09-30',owner:'other'}}]}).mockResolvedValueOnce({stop_reason:'end_turn',content:[{type:'text',text:'Resumen'}]})
 expect((await POST(req(input))).status).toBe(200)
 for(const c of m.query.mock.calls)expect(c[1][2]).toBe('00000000-0000-4000-8000-000000000001')
 expect(m.query).toHaveBeenCalledTimes(2)
})
it('shows missing configuration and provider errors without secrets',async()=>{
 vi.stubEnv('ANTHROPIC_API_KEY','');expect((await POST(req(input))).status).toBe(503)
 vi.stubEnv('ANTHROPIC_API_KEY','synthetic');m.create.mockRejectedValue(Error('private upstream detail'))
 const r=await POST(req(input));expect(r.status).toBe(502);expect(await r.text()).not.toContain('private')
})
