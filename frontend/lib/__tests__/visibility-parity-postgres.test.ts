// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import {createRequire} from 'node:module'
import { NextRequest } from 'next/server'
import type { SessionUser } from '@/lib/auth'
const mocks = vi.hoisted(() => ({query: vi.fn(), poolQuery: vi.fn(), transaction: vi.fn(), client: vi.fn(), session: null as SessionUser | null, lines: vi.fn()}))
vi.mock('@/lib/db', () => ({query: mocks.query, pool: {query: mocks.poolQuery}, withTransaction: mocks.transaction, getLongRunningClient: mocks.client}))
vi.mock('@/lib/auth', () => ({getSessionFromRequest: () => mocks.session}))
vi.mock('@/lib/line-visibility', () => ({getAccessibleLineIds: mocks.lines}))
vi.mock('@/lib/audit', () => ({audit: vi.fn()}))
vi.mock('@/lib/casino-segmentation', () => ({prepareSegmentation: vi.fn(), applySegmentation: vi.fn(), activityPreservationPlatforms: () => []}))
vi.mock('@/lib/app-settings', () => ({getAppSetting: async () => true}))
import { GET as list, POST as create } from '@/app/api/contacts/route'
import { PATCH as edit } from '@/app/api/contacts/[id]/route'
import { PUT as tags } from '@/app/api/contacts/[id]/tags/route'
import { POST as importContacts } from '@/app/api/contacts/import/route'
import { POST as checkImport } from '@/app/api/contacts/import/check/route'
import { GET as campaignContacts } from '@/app/api/campaigns/[id]/contacts/route'
import { GET as inbox } from '@/app/api/conversations/route'
import { POST as note, GET as notes } from '@/app/api/conversations/[phone]/notes/route'
import { PATCH as status } from '@/app/api/conversations/[phone]/status/route'
import { POST as blacklist } from '@/app/api/conversations/[phone]/blacklist/route'
import { GET as notifications } from '@/app/api/notifications/route'
import { POST as markRead } from '@/app/api/notifications/mark-all-read/route'
import { GET as preferences } from '@/app/api/notifications/preferences/route'
import { notify } from '@/lib/notify'
import { canSeeContact } from '@/lib/contact-visibility'
import { canReadConversation } from '@/lib/conversation-access'
import { GET as lists, POST as createList } from '@/app/api/lists/route'
import { campaignAudienceError } from '@/lib/campaign-audience'
import { LtvRepository } from '@/lib/ltv/LtvRepository'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const phone = (n: number) => `549110000000${n}`
const req = (path: string, body?: object, method = 'POST') => new NextRequest('http://localhost/api/' + path, body ? {method, body: JSON.stringify(body)} : undefined)
const contact = (n: number) => ({params: Promise.resolve({id: id(n)})})
const conv = (n: number) => ({params: Promise.resolve({phone: phone(n)})})

describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('one visibility policy on real PostgreSQL', () => {
  let db: Client
  const schema = `visibility_${process.pid}_${Date.now()}`
  beforeAll(async () => {
    const url = new URL(process.env.OPS_TEST_DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname) || url.search) throw Error('Local database only')
    db = new Client({connectionString: url.toString(), ssl: false}); await db.connect()
    await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public;
      CREATE TYPE contact_segment AS ENUM ('bajo','medio','vip','super_vip'); CREATE TYPE gaming_type AS ENUM ('slots');
      CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),external_id text,phone_number text UNIQUE,
        first_name text,last_name text,email text,panel text,panels_assigned text[] DEFAULT '{}',casino_accounts jsonb DEFAULT '[]',
        platforms text[] DEFAULT '{}',deleted_at timestamptz,segment contact_segment,gaming gaming_type,linea smallint,linea_sub text,status text,
        opt_in_marketing bool,opt_in_sms bool,platform_source text,created_at timestamptz DEFAULT now(),updated_at timestamptz,total_deposits int,total_withdrawals int,last_deposit_at timestamptz);
      CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid,assigned_by uuid,PRIMARY KEY(operator_id,contact_id));
      CREATE TABLE contact_tags(contact_id uuid,tag text,added_at timestamptz DEFAULT now(),UNIQUE(contact_id,tag));
      CREATE TABLE users(id uuid PRIMARY KEY,role text,sectors text[],is_active bool DEFAULT true,session_version int DEFAULT 1,
        can_download_contacts bool DEFAULT true,allowed_agents text[],is_super_admin bool DEFAULT false);
      CREATE TABLE contact_lists(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,description text,filters jsonb,owned_by uuid,updated_by uuid,source text,created_at timestamptz DEFAULT now());
      CREATE TABLE contact_list_members(list_id uuid,contact_id uuid,PRIMARY KEY(list_id,contact_id));
      CREATE TABLE campaigns(id uuid PRIMARY KEY,name text,owned_by uuid,list_id uuid,prospect_list_id uuid);
      CREATE TABLE campaign_recipients(campaign_id uuid,contact_id uuid,prospect_id uuid,phone_number text,status text,failed_at timestamptz,error_detail text);
      CREATE TABLE prospects(id uuid,phone_number text,first_name text,last_name text);
      CREATE TABLE prospect_list_members(prospect_list_id uuid,prospect_id uuid);
      CREATE TABLE whatsapp_messages(id uuid DEFAULT gen_random_uuid(),phone_number text,message_body text,direction text,status text,created_at timestamptz DEFAULT now(),evolution_message_id text,campaign_id uuid,sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,error_detail text);
      CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid);
      CREATE TABLE cloud_conversations(id uuid,contact_phone text);
      CREATE TABLE cloud_messages(id uuid DEFAULT gen_random_uuid(),conversation_id uuid,phone_number_id text,wamid text,direction text,message_type text,content jsonb,status text,sent_at timestamptz,created_at timestamptz DEFAULT now(),campaign_id uuid);
      CREATE TABLE conversation_notes(id uuid DEFAULT gen_random_uuid(),phone text,content text,author_id uuid,author_name text,created_at timestamptz DEFAULT now());
      CREATE TABLE conversation_state(phone_number text,current_flow text,last_activity_at timestamptz,updated_at timestamptz,resolved_at timestamptz,is_escalated bool,escalation_reason text);
      CREATE UNIQUE INDEX ON conversation_state(phone_number) WHERE resolved_at IS NULL;
      CREATE TABLE blacklist(phone_number_normalized text,removed_at timestamptz);
      CREATE TABLE notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,type text,title text,body text,link text,related_type text,related_id text,metadata jsonb,is_read bool DEFAULT false,read_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE notification_preferences(user_id uuid,notify_mensaje_nuevo bool);
      CREATE TABLE tasks(id uuid,deleted_at timestamptz); CREATE TABLE task_assignees(task_id uuid,user_id uuid);
      CREATE TABLE casino_contact_account_links(contact_id uuid,player_id uuid);
      CREATE TABLE mv_player_ltv(casino_player_id uuid,username text,agente text,seg_monto text,ngr_total numeric,arpu numeric,dias_activo int,ltv_percentil numeric,ltv_score numeric,tier_ltv text,calculado_en timestamptz);
    `)
    await db.query("CREATE TABLE casino_transactions(id bigint,platform text,username text,agente text,fecha date,fecha_hora_utc timestamptz,tipo text,monto numeric,raw_detalles text)")
    await createRequire(import.meta.url)('../../../tests/helpers/segmentation-profile-schema.cjs').install(db,schema)
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.poolQuery.mockImplementation((sql, params) => db.query(sql, params))
    mocks.client.mockImplementation(async () => ({query: db.query.bind(db), end: async () => {}}))
    mocks.transaction.mockImplementation(async fn => {await db.query('BEGIN'); try {const r=await fn(db);await db.query('COMMIT');return r} catch(e) {await db.query('ROLLBACK');throw e}})
  })
  beforeEach(async () => {
    await db.query(`TRUNCATE campaign_recipients,prospects,prospect_list_members,contact_lists,contact_list_members,contacts,operator_contact_visibility,contact_tags,users,campaigns,whatsapp_messages,cloud_numbers,cloud_conversations,cloud_messages,conversation_notes,conversation_state,notifications,notification_preferences,casino_contact_account_links,mv_player_ltv CASCADE`)
    mocks.session = {user_id: id(900),role: 'operator',sectors: ['contacts','conversations'],allowed_agents: ['royal'],session_version: 1,email: 'test@example.invalid',name: 'Test'} as SessionUser
    await db.query(`INSERT INTO users(id,role,sectors,allowed_agents) VALUES($1,'operator',ARRAY['contacts','conversations'],ARRAY['royal']);
    `, [id(900)])
    await db.query(`INSERT INTO contacts(id,phone_number,first_name,panel) VALUES($1,$4,'visible','royal'),($2,$5,'hidden','farabet'),($3,$6,'second','royal')`, [id(1),id(2),id(3),'+'+phone(1),'+'+phone(2),'+'+phone(3)])
    await db.query(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status) VALUES($1,'visible','inbound','received'),($2,'hidden','inbound','received'),($3,'second','inbound','received')`, [phone(1),phone(2),phone(3)])
    mocks.lines.mockResolvedValue([id(80)])
    // Fresh/TRUNCATEd tables have no useful planner statistics. PostgreSQL's
    // defaults overestimate the correlated visibility query enough to trigger
    // expensive LLVM JIT on Linux CI (>780k cost for a single notification).
    // Keep the real SQL and 5s timeout; analyze only this fixture's tiny tables.
    const tables = (await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema])).rows
    await db.query('ANALYZE ' + tables.map(t => `${schema}."${t.tablename}"`).join(', '))
  })
  afterAll(async () => { if(db) {await db.query('ROLLBACK');await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()} })
  const listed = async () => (await (await list(req('contacts?select_all=true'))).json()).ids
  const imported = (n: number, extra: object = {}) => importContacts(req('contacts/import',{panel:'royal',contacts:[{phone:'+'+phone(n),name:'updated'}],...extra}))
  it('uses the agent fallback consistently for list, individual read, edit and import check', async () => {
    expect((await listed()).sort()).toEqual([id(1),id(3)])
    expect(await canSeeContact(mocks.session!,id(1))).toBe(true)
    expect(await canSeeContact(mocks.session!,id(2))).toBe(false)
    expect((await edit(req('contacts/id',{first_name:'changed'},'PATCH'),contact(1))).status).toBe(200)
    expect((await edit(req('contacts/id',{first_name:'stolen'},'PATCH'),contact(2))).status).toBe(403)
    expect(await (await checkImport(req('contacts/import/check',{phones:['+'+phone(1),'+'+phone(2)]}))).json()).toEqual({total:1,by_panel:{royal:1}})
  })
  it('restricts explicit assignments further, including direct notes and tags', async () => {
    await db.query('INSERT INTO operator_contact_visibility VALUES($1,$2,$1)',[id(900),id(1)])
    expect(await listed()).toEqual([id(1)])
    expect((await tags(req('contacts/id/tags',{tags:['private']},'PUT'),contact(3))).status).toBe(403)
    expect((await tags(req('contacts/id/tags',{tags:['visible']},'PUT'),contact(1))).status).toBe(200)
    expect((await notes(req('conversations/phone/notes'),conv(3))).status).toBe(403)
    expect((await note(req('conversations/phone/notes',{content:'allowed'}),conv(1))).status).toBe(200)
  })
  it.each(['update','panels_only','skip'])('rejects a mixed import atomically in %s mode', async conflict_mode => {
    const result=await imported(2,{conflict_mode,contacts:[{phone:'+'+phone(4),name:'new'},{phone:'+'+phone(2),name:'hidden change'}]})
    expect(result.status).toBe(403)
    expect((await db.query('SELECT first_name FROM contacts WHERE id=$1',[id(2)])).rows[0].first_name).toBe('hidden')
    expect((await db.query('SELECT count(*) FROM contacts')).rows[0].count).toBe('3')
  })
  it('imports visible contacts and keeps new contacts visible in explicit-assignment mode', async () => {
    expect((await imported(1)).status).toBe(200)
    await db.query('INSERT INTO operator_contact_visibility VALUES($1,$2,$1)',[id(900),id(1)])
    expect((await imported(4)).status).toBe(200)
    const {rows:[newContact]}=await db.query('SELECT id FROM contacts WHERE phone_number=$1',['+'+phone(4)])
    expect((await listed()).sort()).toEqual([id(1),newContact.id].sort())
    expect((await create(req('contacts',{phone:'+'+phone(5),panel:'royal'}))).status).toBe(200)
    expect(await listed()).toHaveLength(3)
  })
  it('does not introduce an explicit-assignment restriction for users who have none', async () => {
    expect((await imported(4)).status).toBe(200)
    expect((await db.query('SELECT count(*) FROM operator_contact_visibility')).rows[0].count).toBe('0')
    expect(await listed()).toHaveLength(3)
  })
  it('rejects moving, creating or importing contacts into an unauthorized agent', async () => {
    expect((await edit(req('contacts/id',{panel:'farabet'},'PATCH'),contact(1))).status).toBe(403)
    expect((await create(req('contacts',{phone:'+'+phone(4),panel:'farabet'}))).status).toBe(403)
    expect((await imported(4,{panel:'farabet'})).status).toBe(403)
  })
  it('keeps viewer writes denied even when the conversation is visible', async () => {
    await db.query("UPDATE users SET role='viewer'")
    expect((await note(req('conversations/phone/notes',{content:'forbidden'}),conv(1))).status).toBe(403)
    expect((await status(req('conversations/phone/status',{flow:'en_proceso'},'PATCH'),conv(1))).status).toBe(403)
    expect((await blacklist(req('conversations/phone/blacklist',{}),conv(1))).status).toBe(403)
    expect((await imported(1)).status).toBe(403)
  })
  it('filters inbox, direct messages and campaign options with the same contact scope', async () => {
    await db.query('INSERT INTO campaigns(id,name,owned_by) VALUES($1,$2,$3)',[id(50),'hidden campaign',id(901)])
    await db.query("UPDATE whatsapp_messages SET direction='outbound',status='sent',campaign_id=$1 WHERE phone_number=$2",[id(50),phone(2)])
    const body=await (await inbox(req('conversations'))).json()
    expect(body.total).toBe(2);expect(body.campaigns).toEqual([])
    expect((await (await inbox(req('conversations?phone='+phone(2)))).json()).messages).toEqual([])
    expect(await canReadConversation(mocks.session!,phone(2))).toBe(false)
    await db.query('UPDATE contacts SET deleted_at=now() WHERE id=$1',[id(1)])
    expect(await canReadConversation(mocks.session!,phone(1))).toBe(false)
  })
  it('does not expose hidden Cloud lines through duplicated legacy messages', async () => {
    await db.query('INSERT INTO cloud_numbers VALUES($1,$2)', ['hidden',id(81)])
    await db.query('INSERT INTO cloud_conversations VALUES($1,$2)',[id(82),phone(1)])
    await db.query("INSERT INTO cloud_messages(conversation_id,phone_number_id,wamid,direction,content,message_type,status) VALUES($1,'hidden','duplicated','inbound','{}','text','received')",[id(82)])
    await db.query("UPDATE whatsapp_messages SET evolution_message_id='duplicated' WHERE phone_number=$1",[phone(1)])
    expect(await canReadConversation(mocks.session!,phone(1))).toBe(false)
  })
  it('hides notifications on delivery and on later reads when visibility is revoked', async () => {
    for (const n of [1,2]) await notify({userId:id(900),type:'mensaje_nuevo',title:'message',body:'private body',relatedType:'conversation',relatedId:phone(n)})
    expect((await db.query('SELECT count(*) FROM notifications')).rows[0].count).toBe('1')
    expect((await (await notifications(req('notifications'))).json()).total).toBe(1)
    await db.query("UPDATE contacts SET panel='farabet' WHERE id=$1",[id(1)])
    expect((await (await notifications(req('notifications'))).json())).toMatchObject({notifications:[],total:0,unread:0})
    expect((await markRead(req('notifications/mark-all-read',{}))).status).toBe(200)
    expect((await db.query('SELECT is_read FROM notifications')).rows[0].is_read).toBe(false)
  })
  it('checks current session revocation and active status for notifications and preferences', async () => {
    await db.query('UPDATE users SET session_version=2')
    expect((await notifications(req('notifications'))).status).toBe(401)
    expect((await preferences(req('notifications/preferences'))).status).toBe(401)
    await db.query('UPDATE users SET session_version=1,is_active=false')
    await notify({userId:id(900),type:'mensaje_nuevo',title:'hidden',relatedType:'conversation',relatedId:phone(1)})
    expect((await db.query('SELECT count(*) FROM notifications')).rows[0].count).toBe('0')
  })
  it('scopes LTV by real linked contact IDs, never an unrelated username', async () => {
    await db.query(`INSERT INTO mv_player_ltv(casino_player_id,username,tier_ltv,ltv_score,calculado_en) VALUES($1,'same-name','medio',1,now()),($2,'same-name','medio',1,now());`,[id(60),id(61)])
    await db.query('INSERT INTO casino_contact_account_links VALUES($1,$3),($2,$4)',[id(1),id(2),id(60),id(61)])
    const result=await new LtvRepository().getPlayers({access:mocks.session!})
    expect(result.total).toBe(1);expect(result.data[0].casinoPlayerId).toBe(id(60))
  })
  it('restricts list selections, criteria, counts and campaign audience checks', async () => {
    expect((await createList(req('lists',{name:'bad',contact_ids:[id(1),id(2)]}))).status).toBe(403)
    expect((await db.query('SELECT count(*) FROM contact_lists')).rows[0].count).toBe('0')
    const made=await (await createList(req('lists',{name:'good',criteria:{}}))).json()
    expect(made.total).toBe(2)
    expect(await campaignAudienceError(mocks.session!,{list_id:made.id})).toBe(null)
    await db.query("UPDATE contacts SET panel='farabet' WHERE id=$1",[id(3)])
    expect((await (await lists(req('lists'))).json()).lists[0].contact_count).toBe(1)
    expect((await campaignAudienceError(mocks.session!,{list_id:made.id}))?.status).toBe(403)
  })
  it('preserves a chosen level and restores the calculated level even for legacy clients',async()=>{
    await db.query(`UPDATE contacts SET segmentation_profile='{"monthly_average":500000}' WHERE id=$1`,[id(1)])
    expect((await edit(req('contacts/id',{segment:'super_vip'},'PATCH'),contact(1))).status).toBe(200)
    expect((await db.query('SELECT segment,segment_is_manual FROM contacts WHERE id=$1',[id(1)])).rows[0]).toEqual({segment:'super_vip',segment_is_manual:true})
    expect((await edit(req('contacts/id',{segment:'bajo',segment_mode:'automatic'},'PATCH'),contact(1))).status).toBe(200)
    expect((await db.query('SELECT segment,segment_is_manual FROM contacts WHERE id=$1',[id(1)])).rows[0]).toEqual({segment:'vip',segment_is_manual:false})
  })
  it('denies NULL agents and mixed aliases rather than treating NULL as visible', async () => {
    await db.query('UPDATE contacts SET panel=NULL WHERE id=$1',[id(1)])
    expect(await canReadConversation(mocks.session!,phone(1))).toBe(false)
    await db.query('INSERT INTO contacts(phone_number,panel) VALUES($1,$2)',[phone(3),'farabet'])
    expect(await canReadConversation(mocks.session!,phone(3))).toBe(false)
  })
  it('permits unknown Cloud inbound phones only on visible lines; known contacts still require agent access', async () => {
    await db.query("INSERT INTO cloud_numbers VALUES('visible',$1),('hidden',$2)",[id(80),id(81)])
    await db.query('INSERT INTO cloud_conversations VALUES($1,$3),($2,$4)',[id(82),id(83),phone(4),phone(2)])
    await db.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,wamid,direction,content,message_type,status)
      VALUES($1,'visible','new1','inbound','{}','text','received'),($2,'visible','new2','inbound','{}','text','received')`,[id(82),id(83)])
    expect(await canReadConversation(mocks.session!,phone(4))).toBe(true)
    expect(await canReadConversation(mocks.session!,phone(2))).toBe(false)
    mocks.lines.mockResolvedValue([])
    expect(await canReadConversation(mocks.session!,phone(4))).toBe(false)
  })
  it('keeps administrative contact access independent of operator assignments', async () => {
    await db.query("UPDATE users SET role='admin'")
    expect(await listed()).toHaveLength(3)
    expect((await edit(req('contacts/id',{first_name:'admin'},'PATCH'),contact(2))).status).toBe(200)
  })

  it.each(['recipients','list','legacy'])('filters historical campaign contacts through the %s read path', async source => {
    await db.query("UPDATE users SET sectors=ARRAY['contacts','campaigns','conversations']")
    await db.query('INSERT INTO campaigns(id,name,owned_by,list_id) VALUES($1,$2,$3,$4)',[id(50),'campaign',id(900),id(51)])
    if(source==='recipients') await db.query(`INSERT INTO campaign_recipients(campaign_id,contact_id,phone_number,status)
      VALUES($1,$2,$4,'sent'),($1,$3,$5,'sent')`,[id(50),id(1),id(2),phone(1),phone(2)])
    if(source==='list') await db.query('INSERT INTO contact_list_members VALUES($1,$2),($1,$3)',[id(51),id(1),id(2)])
    if(source==='legacy') await db.query('UPDATE whatsapp_messages SET campaign_id=$1 WHERE phone_number=ANY($2::text[])',[id(50),[phone(1),phone(2)]])
    const result=await campaignContacts(req('campaigns/id/contacts'),{params:Promise.resolve({id:id(50)})})
    expect(result.status).toBe(200)
    const body=await result.json();expect(body.contacts).toHaveLength(1);expect(body.contacts[0].contact_id).toBe(id(1))
  })

})
