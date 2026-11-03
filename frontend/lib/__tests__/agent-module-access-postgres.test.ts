// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
vi.mock('@/lib/db',()=>({query:vi.fn()}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
import { query } from '@/lib/db'
import { agentScope, campaignScopeSql } from '@/lib/agent-scope'
import { isCampaignOwnerOrAdmin, canAccess } from '@/lib/permissions'
import { authorizedDashboardAgent, accessibleDashboardAgents } from '@/lib/dashboard-access'
import { dashboardAgentSql } from '@/lib/dashboard-scope'
import { GET as automations, POST as createRule } from '@/app/api/automations/route'
import { PATCH as editRule, GET as readRule } from '@/app/api/automations/[id]/route'
import { GET as logs } from '@/app/api/automations/logs/route'
import { PATCH as labelPlayer } from '@/app/api/dashboard/casino/players/[username]/route'
import { makeAdminSession, makeReqWithSession, TEST_AUTH_SECRET } from './helpers/session'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const royal={user_id:id(2),role:'operator' as const,allowed_agents:['royal'],sectors:['dashboard','campaigns','agents','priorities','automations']}
const req=(path:string,method='GET',body?:unknown,user=2)=>makeReqWithSession('http://localhost'+path,makeAdminSession({user_id:id(user)}),{method,...(body?{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})}) as NextRequest

describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('agent module permissions on PostgreSQL',()=>{
 let db:Pool
 const schema='agent_modules_'+randomUUID().replaceAll('-','')
 beforeAll(async()=>{
  const url=new URL(process.env.OPS_TEST_DATABASE_URL!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Pool({connectionString:url.toString(),options:`-c search_path=${schema},pg_catalog`})
  await db.query(`CREATE SCHEMA ${schema};
    CREATE TABLE users(id uuid,role text,sectors jsonb,is_active boolean DEFAULT true,session_version int DEFAULT 1,can_download_contacts boolean DEFAULT false,allowed_agents text[],is_super_admin boolean,manager_id uuid,name text);
    INSERT INTO users(id,role,sectors,allowed_agents,is_super_admin) VALUES
      ('${id(1)}','admin','[]','{}',true),
      ('${id(2)}','operator','["contacts","dashboard","automations"]','{royal}',true),
      ('${id(3)}','viewer','["dashboard","automations"]','{royal}',false);
    CREATE TABLE whatsapp_lines(id uuid,owner_user_id uuid);
    INSERT INTO whatsapp_lines VALUES('${id(10)}','${id(2)}'),('${id(11)}',NULL),('${id(12)}','${id(1)}');
    CREATE TABLE line_grants(line_id uuid,granted_to uuid);
    INSERT INTO line_grants VALUES('${id(12)}','${id(2)}');
    CREATE TABLE automation_logs(id uuid DEFAULT gen_random_uuid(),automation_id uuid,automation_name text,conversation_phone text,message_id uuid,result text,details text,created_at timestamptz DEFAULT NOW());
    CREATE TABLE automations(id uuid DEFAULT gen_random_uuid(),name text,description text,type text,trigger_type text,trigger_config jsonb,action_config jsonb,is_active boolean,priority int,created_by uuid,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW());
    CREATE TABLE campaigns(id uuid,owned_by uuid,agent_key text);
    INSERT INTO campaigns VALUES('${id(20)}','${id(1)}','royal'),('${id(21)}','${id(2)}','bigwin'),('${id(22)}','${id(2)}',NULL);
    CREATE TABLE casino_players(username_lower text,platform text,agente text,labels text[] DEFAULT '{}');
    INSERT INTO casino_players(username_lower,platform,agente) VALUES('shared','zeus','royal'),('shared','ganamos','adminroyal'),('shared','zeus','bigwin');
    CREATE TABLE movements(platform text,agente text,amount int);
    INSERT INTO movements VALUES('zeus','royal',10),('ganamos','adminroyal',20),('bet30','zeusroyal',30),('zeus','bigwin',999);`)
  await db.query(readFileSync('../db/migrations/164_agent_module_access.sql','utf8').replaceAll('public.',schema+'.'))
  await db.query(`INSERT INTO automations(id,name,type,trigger_type,trigger_config,action_config,is_active,priority,created_by) VALUES
    ('${id(30)}','Royal','reply','keyword','{"keywords":["BENEFICIO"]}','{"message":"Royal","contact_line_directory":"royal"}',true,1,'${id(1)}'),
    ('${id(31)}','Bigwin','reply','keyword','{"keywords":["BENEFICIO"]}','{"message":"Privado","contact_line_directory":"bigwin"}',true,1,'${id(1)}');
    INSERT INTO automation_logs(automation_id,conversation_phone,result,details,agent_code) VALUES
      ('${id(30)}','5491111111111','executed','Royal visible','royal'),('${id(30)}','5491111111111','executed','Bigwin privado','bigwin'),('${id(30)}','5491111111111','executed','Sin atribución',NULL);`)
  vi.mocked(query).mockImplementation(async(sql,values)=>(await db.query(sql,values)).rows)
  vi.stubEnv('AUTH_SECRET',TEST_AUTH_SECRET)
 })
 afterAll(async()=>{await db?.query(`DROP SCHEMA ${schema} CASCADE`);await db?.end();vi.unstubAllEnvs()})
 it('preserves Prioridades access and removes stale super-admin privileges on demotion',async()=>{
  const user=(await db.query('SELECT sectors,is_super_admin FROM users WHERE id=$1',[id(2)])).rows[0]
  expect(user.sectors).toContain('priorities');expect(user.is_super_admin).toBe(false)
  expect((await db.query('SELECT * FROM get_accessible_line_ids($1)',[id(2)])).rows).toHaveLength(2)
  await db.query('UPDATE users SET is_super_admin=true WHERE id=$1',[id(2)])
  expect((await db.query('SELECT * FROM get_accessible_line_ids($1)',[id(2)])).rows).toHaveLength(2)
  expect((await db.query('SELECT * FROM get_accessible_line_ids($1)',[id(1)])).rows).toHaveLength(3)
 })
 it('shows centrally created Royal campaigns and denies own-created campaigns assigned elsewhere',async()=>{
  const rows=(await db.query(`SELECT id FROM campaigns c WHERE ${campaignScopeSql('c','$1','$2')}`,[royal.user_id,agentScope(royal)])).rows
  expect(rows).toEqual([{id:id(20)}])
  expect(isCampaignOwnerOrAdmin(royal,id(1),'royal')).toBe(true)
  expect(isCampaignOwnerOrAdmin(royal,id(2),'bigwin')).toBe(false)
  expect(isCampaignOwnerOrAdmin(royal,id(2),null)).toBe(false)
  expect(canAccess(royal,'contacts','read')).toBe(false)
  expect(canAccess(royal,'priorities','read')).toBe(true)
 })
 it('resolves dashboard aliases and never defaults to all agents',async()=>{
  expect(accessibleDashboardAgents(royal,'ganamos')).toEqual(['adminroyal'])
  expect(authorizedDashboardAgent(royal,'consolidado',null)).toEqual({ok:true,agent:'royal'})
  expect(authorizedDashboardAgent(royal,'ganamos',null)).toEqual({ok:true,agent:'adminroyal'})
  expect(authorizedDashboardAgent(royal,'consolidado','bigwin')).toEqual({ok:false})
  expect(authorizedDashboardAgent({...royal,allowed_agents:['!invalid']},'consolidado',null)).toEqual({ok:false})
  const sum=(await db.query(`SELECT sum(amount)::int AS total FROM movements WHERE ${dashboardAgentSql('consolidado',1)}`,['royal'])).rows[0].total
  expect(sum).toBe(60)
 })
 it('updates only authorized player identities and denies viewer writes using fresh roles',async()=>{
  const context={params:Promise.resolve({username:'shared'})}
  expect((await labelPlayer(req('/api/dashboard/casino/players/shared','PATCH',{labels:['vip']}),context)).status).toBe(200)
  expect((await db.query('SELECT labels FROM casino_players WHERE agente=$1',['bigwin'])).rows[0].labels).toEqual([])
  expect((await db.query("SELECT labels FROM casino_players WHERE agente IN ('royal','adminroyal')")).rows.map(r=>r.labels)).toEqual([['vip'],['vip']])
  expect((await labelPlayer(req('/api/dashboard/casino/players/shared','PATCH',{labels:[]},3),context)).status).toBe(403)
 })
 it('scopes automation rules and log attribution, including direct foreign IDs',async()=>{
  expect((await (await automations(req('/api/automations'))).json()).automations.map((r:any)=>r.id)).toEqual([id(30)])
  expect((await readRule(req('/api/automations/'+id(31)),{params:Promise.resolve({id:id(31)})})).status).toBe(404)
  expect((await (await logs(req('/api/automations/logs'))).json()).logs.map((r:any)=>r.details)).toEqual(['Royal visible'])
  expect((await editRule(req('/api/automations/'+id(30),'PATCH',{action_config:{message:'Nuevo',contact_line_directory:'royal'}}),{params:Promise.resolve({id:id(30)})})).status).toBe(200)
  expect((await editRule(req('/api/automations/'+id(30),'PATCH',{action_config:{message:'Privado',contact_line_directory:'bigwin'}}),{params:Promise.resolve({id:id(30)})})).status).toBe(403)
  expect((await editRule(req('/api/automations/'+id(31),'PATCH',{name:'No permitido'}),{params:Promise.resolve({id:id(31)})})).status).toBe(404)
  const body={name:'Nueva Royal',type:'reply',trigger_type:'keyword',trigger_config:{keywords:['extra']},action_config:{message:'Royal',contact_line_directory:'royal'},is_active:true,priority:1}
  expect((await createRule(req('/api/automations','POST',body))).status).toBe(201)
  expect((await createRule(req('/api/automations','POST',{...body,action_config:{message:'Global'}}))).status).toBe(403)
 })
})
