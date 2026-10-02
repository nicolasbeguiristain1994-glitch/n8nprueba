// @vitest-environment node
import { beforeAll,afterAll,it,expect,describe,vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
const mocks=vi.hoisted(()=>({query:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
import { LtvRepository } from '@/lib/ltv/LtvRepository'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('LTV installed schema and real SQL',()=>{
 let db:Client
 const schema=`completion_ltv_${process.pid}`,repo=new LtvRepository()
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!)
  if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect()
  await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema};
   CREATE TABLE casino_players(id uuid PRIMARY KEY,username text,agente text,platform text,seg_monto text,total_cargas numeric,cant_cargas int,total_retiros numeric,fecha_primera date,fecha_ultima date);
   CREATE TABLE system_jobs(job_name text PRIMARY KEY,is_running boolean DEFAULT false,started_at timestamptz,started_by text,expires_at timestamptz,last_success_at timestamptz,last_result jsonb,lock_token uuid);
   INSERT INTO casino_players VALUES
   ('${id(1)}','low','shared','zeus','bajo',100,2,10,'2026-09-01','2026-09-10'),
   ('${id(2)}','high','shared','zeus','alto',200,2,0,'2026-09-01','2026-09-20'),
   ('${id(3)}','low-other','shared','bet30','bajo',10000,4,100,NULL,NULL),
   ('${id(4)}','high-other','shared','bet30','alto',20000,4,0,NULL,NULL)`)
  const sql=readFileSync('../db/migrations/133_restore_ltv_storage.sql','utf8').replace('SET search_path = public, pg_catalog',`SET search_path = ${schema}, pg_catalog`)
  await db.query(sql);await db.query(sql)
  mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
 })
 afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}})
 it('installs idempotently and returns valid JSONB metrics through repository',async()=>{
  const result=await repo.refreshAll();expect(result.rowsProcessed).toBe(4);expect(result.durationMs).toBeGreaterThanOrEqual(0);expect(result.calculatedAt.getTime()).toBeGreaterThan(0)
 })
 it('keeps percentiles isolated by platform even for identical agent names',async()=>{
  const rows=(await db.query('SELECT casino_player_id,ltv_score,ngr_total,arpu,dias_activo FROM player_ltv ORDER BY casino_player_id')).rows
  expect(rows.map(r=>r.ltv_score)).toEqual([10,60,10,60]);expect(rows[0]).toMatchObject({ngr_total:'90.00',arpu:'50.00',dias_activo:9})
 })
 it('recomputing one player preserves its peer-relative percentile',async()=>{
  await db.query('SELECT refresh_player_ltv($1)',[id(2)])
  expect((await db.query('SELECT ltv_score FROM player_ltv WHERE casino_player_id=$1',[id(2)])).rows[0].ltv_score).toBe(60)
 })
 it('reads distribution, paging, filters and records job ownership',async()=>{
  expect((await repo.getDistribution()).reduce((n,r)=>n+r.total,0)).toBe(4)
  expect((await repo.getPlayers({tierLtv:'super_vip',pageSize:1}))).toMatchObject({total:2,pageSize:1,totalPages:2})
  expect(await repo.acquireLock('local',id(10))).toBe(true);expect(await repo.acquireLock('other',id(11))).toBe(false)
  expect(await repo.releaseLock(id(11),{},true)).toBe(false)
  expect(await repo.releaseLock(id(10),{rowsProcessed:4},true)).toBe(true)
  expect(await repo.getLastSuccessAt()).toBeInstanceOf(Date)
 })
})
