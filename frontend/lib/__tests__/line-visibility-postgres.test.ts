// @vitest-environment node
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest'
import {Client} from 'pg'
vi.mock('@/lib/db',()=>({query:vi.fn()}))
import {distributorVisibilityClause} from '../line-visibility'
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('Distributor visibility on PostgreSQL SETOF uuid',()=>{
 let db:Client
 beforeAll(async()=>{
  const url=new URL(process.env.DATABASE_URL!);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect();await db.query('BEGIN');
  await db.query(`CREATE TEMP TABLE visibility_lines(id uuid,owner_id uuid);
   INSERT INTO visibility_lines VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${owner}'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${other}');
   CREATE FUNCTION pg_temp.get_accessible_line_ids(actor uuid) RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT id FROM visibility_lines WHERE owner_id=actor $$`)
 })
 afterAll(async()=>{if(db){await db.query('ROLLBACK');await db.end()}})
 it('reproduces the original set-returning WHERE error',async()=>{
  await db.query('SAVEPOINT old_query')
  await expect(db.query('SELECT id FROM visibility_lines WHERE id=ANY(pg_temp.get_accessible_line_ids($1::uuid))',[owner])).rejects.toMatchObject({code:'0A000'})
  await db.query('ROLLBACK TO SAVEPOINT old_query')
 })
 it.each([['',1],['wl',1],['wl',2]] as const)('filters accessible lines with alias %s and parameter offset %s',async(alias,offset)=>{
  const {clause,params}=distributorVisibilityClause(owner,offset,alias)
  const rows=(await db.query(`SELECT ${alias?alias+'.':''}id FROM visibility_lines ${alias} WHERE ${offset===2?'$1::boolean':'true'} ${clause.replace('get_accessible_line_ids','pg_temp.get_accessible_line_ids')}`,offset===2?[true,...params]:params)).rows
  expect(rows).toEqual([{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}])
 })
 it('returns no rows when the actor has no accessible lines',async()=>{
  const {clause,params}=distributorVisibilityClause('33333333-3333-4333-8333-333333333333',1,'wl')
  expect((await db.query(`SELECT wl.id FROM visibility_lines wl WHERE true ${clause.replace('get_accessible_line_ids','pg_temp.get_accessible_line_ids')}`,params)).rows).toEqual([])
 })
 it('preserves unrestricted system context',()=>{expect(distributorVisibilityClause(null)).toEqual({clause:'',params:[]})})
})
