// @vitest-environment node
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest'
import {Pool} from 'pg'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
vi.mock('@/lib/db',()=>({query:vi.fn()}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
import {query} from '@/lib/db'
import {GET,POST} from '@/app/api/agents/route'
import {PATCH as rename} from '@/app/api/agents/[code]/route'
import {POST as addLine} from '@/app/api/agents/[code]/lines/route'
import {PATCH as editLine} from '@/app/api/agents/[code]/lines/[id]/route'
import {makeAdminSession,makeReqWithSession,TEST_AUTH_SECRET} from './helpers/session'

describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('agent directory on PostgreSQL with real permissions',()=>{
  let pool:Pool
  const schema='agent_directory_'+randomUUID().replaceAll('-','')
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
  const req=(method='GET',body?:unknown,user=1)=>makeReqWithSession('http://localhost/api/agents',
    makeAdminSession({user_id:id(user)}),{method,...(body?{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})})
  const params=(code:string,line?:string)=>({params:Promise.resolve({code,id:line||id(99)})})
  const line={linea:8,variant:'a',label:'Royal 8A',phone:'+549 11 1234-5678',is_active:true}
  beforeAll(async()=>{
    const url=new URL(process.env.OPS_TEST_DATABASE_URL!)
    if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
    pool=new Pool({connectionString:url.toString(),options:`-c search_path=${schema},pg_catalog`})
    await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE users(id uuid,role text,sectors text[],is_active boolean,session_version int,can_download_contacts boolean,allowed_agents text[],is_super_admin boolean);
      INSERT INTO users VALUES('${id(1)}','admin','{}',true,1,true,'{}',false),('${id(2)}','operator','{agents,conversations}',true,1,true,'{royal}',false),('${id(3)}','viewer','{agents}',true,1,true,'{}',false)`)
    for(const role of ['anon','authenticated'])await pool.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
    await pool.query(readFileSync('../db/migrations/151_agent_contact_lines.sql','utf8').replaceAll('public.',schema+'.'))
    vi.mocked(query).mockImplementation(async(sql,values)=>(await pool.query(sql,values)).rows)
    vi.stubEnv('AUTH_SECRET',TEST_AUTH_SECRET)
  })
  beforeEach(async()=>{await pool.query("DELETE FROM agent_contact_lines WHERE agent_code='test-agent'; DELETE FROM crm_agents WHERE code='test-agent'; DELETE FROM agent_contact_lines WHERE agent_code='royal'")})
  afterAll(async()=>{vi.unstubAllEnvs();if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})
  it('migrates all existing Ofizeus numbers and prevents direct Data API access',async()=>{
    const result=await(await GET(req())).json()
    expect(result.agents).toHaveLength(6)
    expect(result.agents.find((a:{code:string})=>a.code==='ofizeus').lines).toHaveLength(16)
    const rows=(await pool.query(`SELECT relrowsecurity,
      has_table_privilege('anon',oid,'SELECT') AS anon_read,has_table_privilege('authenticated',oid,'UPDATE') AS authenticated_write
      FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('crm_agents','agent_contact_lines')`,[schema])).rows
    expect(rows).toHaveLength(2)
    expect(rows.every(r=>r.relrowsecurity&&!r.anon_read&&!r.authenticated_write)).toBe(true)
  })
  it('creates and renames agents, normalizes phones and rejects duplicate assignments',async()=>{
    expect((await POST(req('POST',{code:'test-agent',name:'Agente de prueba'}))).status).toBe(201)
    expect((await POST(req('POST',{code:'test-agent',name:'Duplicado'}))).status).toBe(409)
    expect((await rename(req('PATCH',{name:'Agente actualizado'}),params('test-agent'))).status).toBe(200)
    expect((await addLine(req('POST',line),params('royal'))).status).toBe(201)
    expect((await addLine(req('POST',line),params('royal'))).status).toBe(409)
    const stored=(await pool.query("SELECT phone FROM agent_contact_lines WHERE agent_code='royal'")).rows
    expect(stored).toEqual([{phone:'+5491112345678'}])
  })
  it('edits and deactivates a line without changing contact assignments; checks parent ID',async()=>{
    const data=await(await addLine(req('POST',line),params('royal'))).json()
    const updated={label:'Atención Royal',phone:'+5491199999999',is_active:false}
    expect((await editLine(req('PATCH',updated),params('bigwin',data.id))).status).toBe(404)
    expect((await editLine(req('PATCH',updated),params('royal',data.id))).status).toBe(200)
    expect((await pool.query('SELECT linea,variant,label,phone,is_active FROM agent_contact_lines WHERE id=$1',[data.id])).rows[0])
      .toEqual({...updated,linea:8,variant:'a'})
  })
  it('rejects unauthenticated users, operators and viewers even if their cookie claims admin',async()=>{
    expect((await GET(new Request('http://localhost/api/agents'))).status).toBe(401)
    for(const user of [2,3]){
      expect((await GET(req('GET',undefined,user))).status).toBe(403)
      expect((await POST(req('POST',{code:'test-agent',name:'Test'},user))).status).toBe(403)
      expect((await rename(req('PATCH',{name:'Hacked'},user),params('royal'))).status).toBe(403)
      expect((await addLine(req('POST',line,user),params('royal'))).status).toBe(403)
      expect((await editLine(req('PATCH',line,user),params('royal'))).status).toBe(403)
    }
  })
  it('rejects invalid numbers, variants, unknown agents and attempts to change the assignment key',async()=>{
    for(const invalid of [{...line,phone:'1123456789'},{...line,phone:'https://evil.test'},{...line,linea:0},{...line,variant:'d'}])
      expect((await addLine(req('POST',invalid),params('royal'))).status).toBe(400)
    expect((await addLine(req('POST',line),params('missing'))).status).toBe(404)
    expect((await editLine(req('PATCH',line),params('royal'))).status).toBe(400)
  })
})
