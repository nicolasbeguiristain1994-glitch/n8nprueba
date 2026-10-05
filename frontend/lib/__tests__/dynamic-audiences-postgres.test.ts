// @vitest-environment node
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest'
import {Client} from 'pg'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const database=vi.hoisted(()=>({query:vi.fn(),withTransaction:vi.fn(),getLongRunningClient:vi.fn()}))
vi.mock('@/lib/db',()=>database)
import {ensureCampaignAudienceSnapshot,resolveSavedAudience,savedAudienceParams,campaignMembershipSQL} from '@/lib/dynamic-audiences'
const url=process.env.CONTACTS_TEST_DATABASE_URL
const admin='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
describe.skipIf(!url)('Dynamic audiences on local PostgreSQL',()=>{
 let db:Client
 const schema=`dynamic_audiences_${process.pid}`
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||parsed.search)throw Error('Local database required')
  db=new Client({connectionString:url});await db.connect();await db.query(`CREATE SCHEMA ${schema};SET search_path=${schema},public`)
  await db.query(readFileSync('../db/migrations/028_casino_transactions.sql','utf8'))
  await db.query(`ALTER TABLE casino_transactions ADD platform text,ADD fecha_hora_utc timestamptz;
    CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number text,first_name text,last_name text,segment text,panel text,panels_assigned text[] DEFAULT '{}',deleted_at timestamptz,last_deposit_at timestamptz,platforms text[] DEFAULT '{}');
    CREATE TABLE contact_lists(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owned_by uuid,filters jsonb);
    CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owned_by uuid,list_id uuid);
    CREATE TABLE contact_list_members(list_id uuid,contact_id uuid,UNIQUE(list_id,contact_id));
    CREATE TABLE campaign_recipients(campaign_id uuid,contact_id uuid);
    CREATE TABLE users(id uuid PRIMARY KEY,role text,allowed_agents text[],is_active bool);
    CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid);
    CREATE TABLE contact_tags(contact_id uuid,tag text);`)
  await createRequire(import.meta.url)('../../../tests/helpers/segmentation-profile-schema.cjs').install(db,schema)
  database.query.mockImplementation(async(q,p)=>(await db.query(q,p)).rows)
  database.withTransaction.mockImplementation(async fn=>{await db.query('BEGIN');try{const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}})
 })
 beforeEach(async()=>{
  await db.query('TRUNCATE contacts,contact_lists,campaigns,contact_list_members,campaign_recipients,users,operator_contact_visibility CASCADE')
  await db.query("INSERT INTO users VALUES($1,'admin','{}',true)",[admin])
 })
 afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}})
 const person=async(amount:number|null,panel='royal')=>(await db.query(`INSERT INTO contacts(panel,segmentation_profile) VALUES($1,$2) RETURNING id`,[panel,amount===null?null:JSON.stringify({monthly_average:amount,deposits:1,first_date:'2026-01-01',last_date:'2026-01-01',estimated:false,partial_history:false})])).rows[0].id as string
 const list=async(filters:object,owner=admin)=>(await db.query('INSERT INTO contact_lists(owned_by,filters,is_dynamic) VALUES($1,$2,true) RETURNING id',[owner,filters])).rows[0].id as string
 const campaign=async(listId:string,owner=admin)=>(await db.query('INSERT INTO campaigns(owned_by,list_id) VALUES($1,$2) RETURNING id',[owner,listId])).rows[0].id as string
 const members=async(campaignId:string,listId:string)=>(await db.query(campaignMembershipSQL,[campaignId,listId])).rows.map(r=>r.contact_id).sort()

 it('rejects executable, unknown and recursively linked audience filters',()=>{
  expect(()=>savedAudienceParams({sql:'DELETE FROM contacts'})).toThrow()
  expect(()=>savedAudienceParams({list_id:admin})).toThrow()
  expect(()=>savedAudienceParams({segment:{operator:'all'}})).toThrow()
 })
 it('keeps the first campaign frozen while the next campaign resolves new matching contacts',async()=>{
  const a=await person(500000),b=await person(1000),l=await list({segment:'vip'}),first=await campaign(l)
  await ensureCampaignAudienceSnapshot(first,l);expect(await members(first,l)).toEqual([a])
  await db.query(`UPDATE contacts SET segmentation_profile=jsonb_set(segmentation_profile,'{monthly_average}','500000') WHERE id=$1`,[b])
  await db.query(`UPDATE contacts SET segmentation_profile=jsonb_set(segmentation_profile,'{monthly_average}','1000') WHERE id=$1`,[a])
  await ensureCampaignAudienceSnapshot(first,l);expect(await members(first,l)).toEqual([a])
  const next=await campaign(l);await ensureCampaignAudienceSnapshot(next,l);expect(await members(next,l)).toEqual([b])
  expect(await members(first,l)).toEqual([a])
 })
 it('freezes even an empty selection, so retries never silently broaden it',async()=>{
  const l=await list({segment:'vip'}),c=await campaign(l);await ensureCampaignAudienceSnapshot(c,l)
  await person(500000);await ensureCampaignAudienceSnapshot(c,l);expect(await members(c,l)).toEqual([])
 })
 it('fails closed for an unrelated list or an already started campaign without a snapshot',async()=>{
  const p=await person(500000),l=await list({segment:'vip'}),c=await campaign(l),other=await list({})
  await expect(ensureCampaignAudienceSnapshot(c,other)).rejects.toThrow('cambió de audiencia')
  await db.query('INSERT INTO campaign_recipients VALUES($1,$2)',[c,p])
  await expect(ensureCampaignAudienceSnapshot(c,l)).rejects.toThrow('ya tiene destinatarios')
  expect((await db.query('SELECT * FROM campaign_audience_members WHERE campaign_id=$1',[c])).rows).toEqual([])
 })
 it('separates unknown history from inactivity and excludes deleted contacts',async()=>{
  const unknown=await person(null),known=await person(1000),deleted=await person(null)
  await db.query('UPDATE contacts SET deleted_at=NOW() WHERE id=$1',[deleted])
  expect(await resolveSavedAudience({calidad:'sin_datos'},{role:'admin',user_id:admin})).toEqual([unknown])
  expect(await resolveSavedAudience({calidad:'observado'},{role:'admin',user_id:admin})).toEqual([known])
  expect(await resolveSavedAudience({sin_movimiento:'true'},{role:'admin',user_id:admin})).toEqual([])
 })
 it('uses the campaign owner scope and refuses inactive owners',async()=>{
  const royal=await person(500000),other=await person(500000,'betcoin')
  await db.query("UPDATE users SET role='operator',allowed_agents=ARRAY['royal'] WHERE id=$1",[admin])
  const l=await list({segment:'vip'}),c=await campaign(l);await ensureCampaignAudienceSnapshot(c,l)
  expect(await members(c,l)).toEqual([royal]);expect(await members(c,l)).not.toContain(other)
  await db.query('UPDATE users SET is_active=false');const next=await campaign(l)
  await expect(ensureCampaignAudienceSnapshot(next,l)).rejects.toThrow('responsable')
  expect(await members(next,l)).toEqual([royal]) // no snapshot: the historical preview is unchanged
  expect((await db.query('SELECT audience_snapshot_at FROM campaigns WHERE id=$1',[next])).rows[0].audience_snapshot_at).toBeNull()
 })
})
