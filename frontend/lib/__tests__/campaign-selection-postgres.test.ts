// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, isOwnerOrAdmin: () => true }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
import { POST as create } from '@/app/api/campaigns/route'
import { POST as preview } from '@/app/api/campaigns/audience-preview/route'
import { GET as lists } from '@/app/api/lists/route'
const owner = '11111111-1111-4111-8111-111111111111'
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`
const request = (body: unknown, path = 'campaigns') => new NextRequest(`https://example.test/api/${path}`, { method: 'POST', body: JSON.stringify(body) })
const selected = [1,2,3,4,5,8].map(id)
describe.skipIf(!process.env.CONTACTS_TEST_DATABASE_URL)('Campaigns created directly from a fixed contact selection', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.CONTACTS_TEST_DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false }); await db.connect(); await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE contacts (id uuid PRIMARY KEY, phone_number text, status text DEFAULT 'active', opt_in_marketing boolean DEFAULT true, do_not_contact boolean DEFAULT false, deleted_at timestamptz, panel text DEFAULT 'royal');
      CREATE TEMP TABLE blacklist (phone_number_normalized text, removed_at timestamptz);
      CREATE TEMP TABLE operator_contact_visibility (contact_id uuid, operator_id uuid);
      CREATE TEMP TABLE contact_lists (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name varchar(255),description text,source text DEFAULT 'user',filters jsonb,owned_by uuid,updated_by uuid,is_dynamic boolean,refreshed_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE contact_list_members (list_id uuid REFERENCES contact_lists(id), contact_id uuid REFERENCES contacts(id),PRIMARY KEY(list_id,contact_id));
      CREATE TEMP TABLE campaigns (id uuid DEFAULT gen_random_uuid(),name text CHECK(name<>'force-failure'),message text,messages jsonb,media_url text,media_type text,list_id uuid,prospect_list_id uuid,type text,status text,scheduled_at timestamptz,total_targets int,antiblock_delay_min int,antiblock_delay_max int,personalize_name boolean,use_multi_line boolean,owned_by uuid,updated_by uuid,message_type text,template_id uuid,template_params jsonb);`)
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows)
    mocks.transaction.mockImplementation(async (fn: (client: Client) => unknown) => {
      await db.query('SAVEPOINT campaign_creation')
      try { const result = await fn(db); await db.query('RELEASE SAVEPOINT campaign_creation'); return result }
      catch (e) { await db.query('ROLLBACK TO SAVEPOINT campaign_creation'); throw e }
    })
  })
  beforeEach(async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'admin', user_id: owner } })
    await db.query('TRUNCATE contact_list_members,contact_lists,campaigns,contacts,blacklist')
    await db.query(`INSERT INTO contacts (id,phone_number,status,opt_in_marketing,do_not_contact,panel,deleted_at) VALUES
      ($1,'+5491100000001','active',true,false,'royal',null),($2,'5491100000001','active',true,false,'royal',null),
      ($3,'+5491100000003','active',true,false,'royal',null),($4,'+5491100000004','active',true,true,'royal',null),
      ($5,'+5491100000005','inactive',true,false,'royal',null),($6,'+5491100000006','active',true,false,'other',null),
      ($7,'+5491100000007','active',true,false,'royal',now()),($8,'+5491100000008','active',false,false,'royal',null)`, Array.from({length:8},(_,i)=>id(i+1)))
    await db.query("INSERT INTO blacklist VALUES ('5491100000003',null)")
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  it('previews exclusions once per contact, deduplicates phones and writes nothing', async () => {
    const res = await preview(request({ contact_ids: [...selected, id(1)] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ selected:6, eligible:1, excluded:5, blacklisted:1, inactive:1, opted_out:2, duplicates:1 })
    expect((await db.query('SELECT * FROM contact_lists')).rows).toHaveLength(0)
  })
  it('saves only eligible selected recipients and a draft, without adding a user list', async () => {
    const res = await create(request({ name:'Desde contactos', message:'Hola', contact_ids:selected }))
    expect(res.status).toBe(200)
    const result = await res.json(), campaign = (await db.query('SELECT * FROM campaigns WHERE id=$1',[result.id])).rows[0]
    expect(campaign).toMatchObject({ status:'draft',total_targets:1,owned_by:owner,message:'Hola',scheduled_at:null })
    expect((await db.query('SELECT contact_id FROM contact_list_members WHERE list_id=$1',[campaign.list_id])).rows).toEqual([{contact_id:id(1)}])
    expect((await db.query('SELECT source,is_dynamic,owned_by FROM contact_lists')).rows).toEqual([{source:'campaign_selection',is_dynamic:false,owned_by:owner}])
    expect((await (await lists(new NextRequest('https://example.test/api/lists'))).json()).lists).toEqual([])
  })
  it('rolls the private audience back if campaign creation fails', async () => {
    expect((await create(request({ name:'force-failure',message:'Hola',contact_ids:[id(1)] }))).status).toBe(500)
    expect((await db.query('SELECT * FROM contact_lists')).rows).toHaveLength(0)
    expect((await db.query('SELECT * FROM contact_list_members')).rows).toHaveLength(0)
  })
  it('rechecks opt-outs at save time instead of trusting an earlier preview', async () => {
    expect((await preview(request({ contact_ids:[id(1)] }))).status).toBe(200)
    await db.query('UPDATE contacts SET do_not_contact=true WHERE id=$1',[id(1)])
    expect((await create(request({ name:'Revisión',message:'Hola',contact_ids:[id(1)] }))).status).toBe(422)
    expect((await db.query('SELECT * FROM contact_lists')).rows).toHaveLength(0)
  })
  it.each([6,7,99])('rejects inaccessible, deleted or missing contacts (%s) without partial writes', async n => {
    mocks.auth.mockResolvedValue({ ok:true,user:{role:'operator',user_id:owner,allowed_agents:['royal']} })
    expect((await preview(request({ contact_ids:[id(1),id(n)] }))).status).toBe(403)
    expect((await create(request({ name:'Denied',message:'Hola',contact_ids:[id(1),id(n)] }))).status).toBe(403)
    expect((await db.query('SELECT * FROM contact_lists')).rows).toHaveLength(0)
  })
  it.each(['campaigns','contacts'])('requires %s permission for direct audiences', async resource => {
    mocks.auth.mockImplementation(async (_req, r) => r===resource ? {ok:false,response:Response.json({error:'Forbidden'},{status:403})} : {ok:true,user:{role:'admin',user_id:owner}})
    expect((await preview(request({contact_ids:[id(1)]}))).status).toBe(403)
    expect((await create(request({name:'Denied',message:'Hola',contact_ids:[id(1)]}))).status).toBe(403)
  })
  it.each([{contact_ids:[]},{contact_ids:['bad']},{contact_ids:[id(1)],list_id:id(10)},{contact_ids:[id(1)],prospect_list_id:id(10)}])('rejects empty, malformed or ambiguous audiences: %j', async body => {
    expect((await create(request({name:'Invalid',message:'Hola',...body}))).status).toBe(400)
    expect((await db.query('SELECT * FROM contact_lists')).rows).toHaveLength(0)
  })
})
