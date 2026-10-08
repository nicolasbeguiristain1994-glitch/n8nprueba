// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
const mocks = vi.hoisted(() => ({ query: vi.fn(), status: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
// This suite isolates legacy campaign delivery; the test ledger has its own real-Postgres suite.
vi.mock('@/lib/campaign-test-delivery', () => ({ recordCampaignTestDelivery: vi.fn() }))
vi.mock('@/lib/cloud-api/repositories/conversation.repository', () => ({ messageRepository: { updateStatus: mocks.status } }))
vi.mock('@/lib/cloud-api/infrastructure/metrics', () => ({ cloudMetrics: { deliveryStatus: vi.fn() } }))
vi.mock('@/lib/cloud-api/infrastructure/logger', () => ({ createLogger: () => ({ logInfo: vi.fn() }) }))
import { handleDeliveryStatus } from '../cloud-api/webhook-handlers/delivery-status.handler'

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('Cloud delivery events on PostgreSQL', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false }); await db.connect(); await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE campaign_recipients(id int,status text,error_detail text,failed_at timestamptz,locked_at timestamptz,updated_at timestamptz);
      CREATE TYPE pg_temp.message_status AS ENUM ('queued','sent','delivered','read','failed');
      CREATE TEMP TABLE contact_send_history(campaign_recipient_id int,frequency_released_at timestamptz,failed_message_id int);
      CREATE TEMP TABLE whatsapp_messages(id serial,campaign_recipient_id int,evolution_message_id text,status pg_temp.message_status,direction text,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,error_detail text,updated_at timestamptz);
      SET LOCAL search_path=pg_temp,public;
      INSERT INTO campaign_recipients(id,status) VALUES(1,'sent'),(2,'sent');
      INSERT INTO whatsapp_messages(campaign_recipient_id,evolution_message_id,status,direction) VALUES(1,'wamid.failure','sent','outbound'),(2,'wamid.delivered','delivered','outbound'),(NULL,'wamid.quick','sent','outbound');`)
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.status.mockResolvedValue(undefined)
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  it('persists the Meta code and detail for campaign messages even without a cloud_messages record', async () => {
    await handleDeliveryStatus('phone', { id:'wamid.failure',status:'failed',timestamp:'1',recipient_id:'test',errors:[{code:131042,title:'Payment issue',message:'Generic title',error_data:{details:'Payment eligibility failed'}}] }, 'test')
    const r=(await db.query('SELECT status,error_detail,failed_at IS NOT NULL AS failed FROM campaign_recipients WHERE id=1')).rows[0]
    expect(r).toEqual({status:'failed',error_detail:'[meta:131042] Payment eligibility failed',failed:true})
    expect(mocks.status).toHaveBeenCalledWith('wamid.failure','failed',expect.objectContaining({errorCode:131042,errorDetails:'Payment eligibility failed'}))
    await handleDeliveryStatus('phone',{id:'wamid.failure',status:'sent',timestamp:'0',recipient_id:'test'},'test')
    expect((await db.query('SELECT status FROM campaign_recipients WHERE id=1')).rows[0].status).toBe('failed')
  })
  it('does not regress a delivered message or recipient when a stale failure arrives', async () => {
    await handleDeliveryStatus('phone',{id:'wamid.delivered',status:'failed',timestamp:'2',recipient_id:'test',errors:[{code:131026,title:'Undeliverable'}]},'test')
    expect((await db.query("SELECT status FROM whatsapp_messages WHERE evolution_message_id='wamid.delivered'")).rows[0].status).toBe('delivered')
    expect((await db.query('SELECT status FROM campaign_recipients WHERE id=2')).rows[0].status).toBe('sent')
  })
  it('records failures on quick-send messages without requiring a campaign recipient', async () => {
    await handleDeliveryStatus('phone',{id:'wamid.quick',status:'failed',timestamp:'2',recipient_id:'test',errors:[{code:131026,title:'Undeliverable'}]},'test')
    expect((await db.query("SELECT status,error_detail FROM whatsapp_messages WHERE evolution_message_id='wamid.quick'")).rows[0]).toEqual({status:'failed',error_detail:'[meta:131026] Undeliverable'})
  })
})
