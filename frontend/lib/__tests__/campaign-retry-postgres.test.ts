// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, type PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/scoring-config-service', () => ({ getAll: async () => ({ allow_threshold:30,delay_threshold:60,cooldown_multiplier:2,risk_weight_daily:40,risk_weight_weekly:35,risk_weight_cooldown:25 }) }))
vi.mock('@/lib/contact-frequency/logger', () => ({ logFrequencyDecision:vi.fn(),logFrequencyError:vi.fn() }))
vi.mock('@/lib/cloud-api/repositories/conversation.repository', () => ({ messageRepository:{updateStatus:vi.fn()} }))
vi.mock('@/lib/cloud-api/infrastructure/metrics', () => ({ cloudMetrics:{deliveryStatus:vi.fn()} }))
vi.mock('@/lib/cloud-api/infrastructure/logger', () => ({ createLogger:()=>({logInfo:vi.fn()}) }))
import { prepareCampaignRetry } from '../campaign-retry'
import { ContactSendHistoryRepository } from '../contact-frequency/repositories/ContactSendHistoryRepository'
import { ContactFrequencyEngine } from '../contact-frequency/ContactFrequencyEngine'
import { handleDeliveryStatus } from '../cloud-api/webhook-handlers/delivery-status.handler'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const campaign=id(100), contact=id(200)

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('confirmed failures and retry attempts on PostgreSQL',()=>{
 let db:Client
 const repo=new ContactSendHistoryRepository()
 beforeAll(async()=>{
  const url=new URL(process.env.DATABASE_URL!)
  if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect();await db.query('BEGIN')
  await db.query(`CREATE TYPE pg_temp.message_status AS ENUM('queued','sent','delivered','read','failed');
   SET LOCAL search_path=pg_temp,public;
   CREATE TEMP TABLE campaign_recipients(id uuid PRIMARY KEY,campaign_id uuid,contact_id uuid,status text,locked_at timestamptz,line_id uuid,evolution_message_id text,error_detail text,failed_at timestamptz,sent_at timestamptz,attempts int,updated_at timestamptz);
   CREATE TEMP TABLE whatsapp_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid,campaign_recipient_id uuid,status pg_temp.message_status,direction text DEFAULT 'outbound',evolution_message_id text,error_detail text,updated_at timestamptz,failed_at timestamptz,delivered_at timestamptz,read_at timestamptz);
   CREATE UNIQUE INDEX ON whatsapp_messages(campaign_recipient_id) WHERE campaign_recipient_id IS NOT NULL;
   CREATE TEMP TABLE contact_send_history(id uuid DEFAULT gen_random_uuid(),contact_id uuid,campaign_id uuid,operator_id uuid,phone_number text,campaign_recipient_id uuid,sent_at timestamptz);
   CREATE UNIQUE INDEX ON contact_send_history(campaign_recipient_id) WHERE campaign_recipient_id IS NOT NULL;
   CREATE TEMP TABLE contact_frequency_rules(id uuid,operator_id uuid,seg_monto text,seg_actividad text,max_per_day int,max_per_week int,min_hours_between_sends int,is_active bool,created_at timestamptz,updated_at timestamptz);
   INSERT INTO contact_frequency_rules VALUES(gen_random_uuid(),NULL,NULL,NULL,1,2,48,true,NOW(),NOW());`)
  const migration=readFileSync(new URL('../../../db/migrations/132_confirmed_failure_retries.sql',import.meta.url),'utf8')
  await db.query(migration);await db.query(migration)
  mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  mocks.transaction.mockImplementation(fn=>fn(db))
 })
 beforeEach(async()=>{await db.query('SAVEPOINT test_case')})
 afterEach(async()=>{await db.query('ROLLBACK TO SAVEPOINT test_case')})
 afterAll(async()=>{if(db){await db.query('ROLLBACK');await db.end()}})
 async function seed(n:number,status='failed',provider:string|null=null,error:string|null='Rejected',crStatus=status){
  await db.query(`INSERT INTO campaign_recipients(id,campaign_id,contact_id,status,evolution_message_id,error_detail,attempts) VALUES($1,$2,$3,$4,$5,$6,1)`,[id(n),campaign,contact,crStatus,provider,error])
  await db.query(`INSERT INTO whatsapp_messages(id,campaign_id,campaign_recipient_id,status,evolution_message_id,error_detail,updated_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 minute')`,[id(n+1000),campaign,id(n),status,provider,error])
  await db.query(`INSERT INTO contact_send_history(contact_id,campaign_id,campaign_recipient_id,sent_at) VALUES($1,$2,$3,NOW()-interval '2 minutes')`,[contact,campaign,id(n)])
 }
 it('does not count confirmed failures in daily/weekly/cooldown, including legacy failures with a provider ID',async()=>{
  await seed(1,'failed','wamid.failed');await seed(2)
  expect(await repo.getFrequencyProfile(contact)).toEqual({sentToday:0,sentThisWeek:0,lastSentAt:null,hoursSinceLastSend:null})
  expect((await db.query('SELECT COUNT(*)::int AS n FROM contact_send_history')).rows[0].n).toBe(2)
 })
 it.each(['queued','sent','delivered','read'])('keeps %s attempts in frequency and excludes them from retry',async status=>{
  await seed(1,status,'wamid.existing',null,'failed')
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
  expect(await prepareCampaignRetry(db as unknown as PoolClient,campaign)).toBe(0)
 })
 it.each(['[provider-outcome-unknown-no-resend] timeout','stale-queued-no-resend'])('keeps an uncertain failure fenced: %s',async error=>{
  await seed(1,'failed',null,error)
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
  expect(await prepareCampaignRetry(db as unknown as PoolClient,campaign)).toBe(0)
 })
 it('archives failed attempts, keeps WAMIDs/history and does not reset opt-out or delivered recipients',async()=>{
  await seed(1,'failed','wamid.failed');await seed(2);await seed(3,'delivered','wamid.delivered',null,'sent')
  await db.query(`INSERT INTO campaign_recipients(id,campaign_id,contact_id,status,error_detail) VALUES($1,$3,$4,'skipped','[freq-blocked] limit'),($2,$3,$4,'skipped','[cloud-opted-out] stop')`,[id(7),id(8),campaign,contact])
  expect(await prepareCampaignRetry(db as unknown as PoolClient,campaign)).toBe(3)
  expect(await prepareCampaignRetry(db as unknown as PoolClient,campaign)).toBe(0)
  expect((await db.query(`SELECT COUNT(*)::int AS n FROM whatsapp_messages WHERE original_campaign_recipient_id IS NOT NULL AND status='failed'`)).rows[0].n).toBe(2)
  expect((await db.query(`SELECT evolution_message_id,campaign_recipient_id FROM whatsapp_messages WHERE id=$1`,[id(1001)])).rows[0]).toEqual({evolution_message_id:'wamid.failed',campaign_recipient_id:null})
  expect((await db.query(`SELECT COUNT(*)::int AS n FROM contact_send_history WHERE frequency_released_at IS NOT NULL AND original_campaign_recipient_id IS NOT NULL`)).rows[0].n).toBe(2)
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
 })
 it('does not release an unconfirmed reservation merely because the recipient was skipped later',async()=>{
  await db.query(`INSERT INTO campaign_recipients(id,campaign_id,contact_id,status,error_detail) VALUES($1,$2,$3,'skipped','[freq-blocked] limit')`,[id(1),campaign,contact])
  await db.query(`INSERT INTO contact_send_history(contact_id,campaign_id,campaign_recipient_id,sent_at) VALUES($1,$2,$3,clock_timestamp())`,[contact,campaign,id(1)])
  expect(await prepareCampaignRetry(db as unknown as PoolClient,campaign)).toBe(0)
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
 })
 it('a new reservation counts immediately even before the old failed message is replaced',async()=>{
  await seed(1)
  const evaluate=()=>ContactFrequencyEngine.atomicEvaluateAndRecord({contactId:contact,operatorId:null,campaignId:campaign},{contactId:contact,campaignId:campaign,operatorId:null,phoneNumber:'synthetic',campaignRecipientId:id(1)})
  expect((await evaluate()).decision).toBe('ALLOW')
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
  expect((await evaluate()).decision).toBe('BLOCK')
  expect((await db.query('SELECT COUNT(*)::int AS n FROM contact_send_history')).rows[0].n).toBe(2)
  await db.query(`UPDATE whatsapp_messages SET status='sent',evolution_message_id='wamid.retry' WHERE campaign_recipient_id=$1`,[id(1)])
  await handleDeliveryStatus('phone',{id:'wamid.retry',status:'delivered',timestamp:'3',recipient_id:'synthetic'},'test')
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
 })
 it('late callbacks for the old attempt do not overwrite the retry; delivery restores its frequency count',async()=>{
  await seed(1,'failed','wamid.old');await prepareCampaignRetry(db as unknown as PoolClient,campaign)
  await db.query(`UPDATE campaign_recipients SET status='sent',evolution_message_id='wamid.new' WHERE id=$1;`,[id(1)])
  await db.query(`INSERT INTO whatsapp_messages(campaign_id,campaign_recipient_id,status,evolution_message_id,updated_at) VALUES($1,$2,'sent','wamid.new',clock_timestamp())`,[campaign,id(1)])
  await db.query(`INSERT INTO contact_send_history(contact_id,campaign_id,campaign_recipient_id,sent_at) VALUES($1,$2,$3,clock_timestamp())`,[contact,campaign,id(1)])
  await handleDeliveryStatus('phone',{id:'wamid.old',status:'failed',timestamp:'1',recipient_id:'synthetic'},'test')
  expect((await db.query('SELECT status,evolution_message_id FROM campaign_recipients WHERE id=$1',[id(1)])).rows[0]).toEqual({status:'sent',evolution_message_id:'wamid.new'})
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(1)
  await handleDeliveryStatus('phone',{id:'wamid.old',status:'delivered',timestamp:'2',recipient_id:'synthetic'},'test')
  expect((await repo.getFrequencyProfile(contact)).sentToday).toBe(2)
 })
 it('rolls back retry archival completely if the transaction fails',async()=>{
  await seed(1,'failed','wamid.original');await db.query('SAVEPOINT before_retry')
  await prepareCampaignRetry(db as unknown as PoolClient,campaign);await db.query('ROLLBACK TO SAVEPOINT before_retry')
  expect((await db.query('SELECT status,evolution_message_id FROM campaign_recipients WHERE id=$1',[id(1)])).rows[0]).toEqual({status:'failed',evolution_message_id:'wamid.original'})
  expect((await db.query('SELECT campaign_recipient_id FROM whatsapp_messages WHERE id=$1',[id(1001)])).rows[0].campaign_recipient_id).toBe(id(1))
 })
})
