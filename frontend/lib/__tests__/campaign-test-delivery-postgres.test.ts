/** @vitest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { WebhookStatus } from '@/lib/cloud-api/types/webhooks'

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/cloud-api/infrastructure/metrics', () => ({ cloudMetrics: { deliveryStatus: vi.fn() } }))
vi.mock('@/lib/cloud-api/infrastructure/logger', () => ({ createLogger: () => ({ logInfo: vi.fn() }) }))
import { completeCampaignTestAttempt, recordCampaignTestDelivery } from '@/lib/campaign-test-delivery'
import { handleDeliveryStatus } from '@/lib/cloud-api/webhook-handlers/delivery-status.handler'

const databaseUrl = process.env.OPS_TEST_DATABASE_URL
  ?? (process.env.RUN_CAMPAIGN_PG_TESTS === '1' ? process.env.DATABASE_URL : undefined)
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const phoneId = '123456789', recipient = '5491112345678', wamid = 'wamid.test.delivery'
const event = (status: WebhookStatus['status'], extra: Partial<WebhookStatus> = {}): WebhookStatus => ({
  id: wamid, status, timestamp: '1791490000', recipient_id: recipient, ...extra,
})
const failure = (code = 141006, timestamp = '1791490000') => event('failed', {
  timestamp, errors: [{ code, title: 'Delivery failure', error_data: { details: 'Payment configuration required' } }],
})

describe.skipIf(!databaseUrl)('test delivery receipts on isolated PostgreSQL', () => {
  let admin: Pool, db: Pool
  const schema = `test_delivery_${randomUUID().replace(/-/g, '')}`
  const migration = readFileSync(new URL('../../../db/migrations/146_campaign_test_delivery.sql', import.meta.url), 'utf8')
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.search || url.hash) throw new Error('LOCAL_ONLY')
    admin = new Pool({ connectionString: url.toString(), ssl: false })
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString: url.toString(), ssl: false, options: `-c search_path=${schema},public`, max: 6 })
    await db.query(`CREATE TABLE campaign_test_sends (
      id uuid PRIMARY KEY,campaign_id uuid,recipient_id uuid,line_id uuid,first_name text,phone_number text,line_name text,
      status text NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','sent','failed','uncertain')),
      provider_message_id text,error text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE cloud_numbers(whatsapp_line_id uuid,phone_number_id text);
      CREATE TYPE message_status AS ENUM('queued','sent','delivered','read','failed');
      CREATE TABLE whatsapp_messages(id int PRIMARY KEY,campaign_recipient_id int,evolution_message_id text,status message_status,
        direction text,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,error_detail text,updated_at timestamptz);
      CREATE TABLE campaign_recipients(id int PRIMARY KEY,status text,error_detail text,failed_at timestamptz,locked_at timestamptz,updated_at timestamptz);
      CREATE TABLE contact_send_history(id int PRIMARY KEY,campaign_recipient_id int,frequency_released_at timestamptz,failed_message_id int);
      CREATE TABLE campaigns(id int PRIMARY KEY,total_sent int,total_failed int,total_skipped int);
      CREATE TABLE cloud_messages(wamid text,status text,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,
        error_code int,error_title text,error_details text,pricing_model text,pricing_category text,billable boolean);`)
    await db.query(`INSERT INTO campaign_test_sends(id,line_id,status) VALUES($1,$3,'sent'),($2,$4,'uncertain')`, [id(90),id(91),id(80),id(81)])
    await db.query(`INSERT INTO cloud_numbers VALUES($1,'unique'),($2,'ambiguous-a'),($2,'ambiguous-b')`, [id(80),id(81)])
    // The release runner owns the transaction. Reapplying here also verifies idempotence.
    const migrationClient = await db.connect()
    try {
      await migrationClient.query('BEGIN')
      await migrationClient.query(migration)
      await migrationClient.query(migration)
      expect((await migrationClient.query('SELECT status,phone_number_id FROM campaign_test_sends ORDER BY id')).rows)
        .toEqual([{ status: 'sent', phone_number_id: 'unique' }, { status: 'uncertain', phone_number_id: null }])
      await migrationClient.query('COMMIT')
    } finally { migrationClient.release() }
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.transaction.mockImplementation(async fn => {
      const client = await db.connect()
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external sends in delivery tests') }))
  })
  beforeEach(async () => {
    await db.query(`TRUNCATE campaign_test_delivery_receipts,campaign_test_sends,cloud_numbers,whatsapp_messages,
      cloud_messages,campaign_recipients,contact_send_history,campaigns;
      INSERT INTO campaign_recipients(id,status) VALUES(1,'skipped');
      INSERT INTO contact_send_history(id,campaign_recipient_id) VALUES(1,1);
      INSERT INTO campaigns VALUES(1,0,0,1);`)
    await seed()
  })
  afterAll(async () => {
    vi.unstubAllGlobals()
    if (db) await db.end()
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end() }
  })
  async function seed(n = 1, sender = phoneId, destination = recipient) {
    await db.query(`INSERT INTO campaign_test_sends(id,campaign_id,recipient_id,line_id,first_name,phone_number,line_name,phone_number_id)
      VALUES($1,$2,$3,$4,'Test',$5,'Test line',$6)`, [id(n), id(10), id(20), id(30+n), '+'+destination, sender])
  }
  const finish = (n = 1, sender = phoneId) => completeCampaignTestAttempt(id(n), sender, 'sent', wamid, null)
  const current = async (n = 1) => (await db.query('SELECT * FROM campaign_test_sends WHERE id=$1', [id(n)])).rows[0]
  const countReceipts = async () => (await db.query('SELECT count(*)::int AS n FROM campaign_test_delivery_receipts')).rows[0].n

  it('records a failed delivery and Meta error without changing normal campaign state or sending again', async () => {
    expect((await finish()).status).toBe('sent')
    await handleDeliveryStatus(phoneId, failure(), 'test')
    expect(await current()).toMatchObject({ status: 'failed', delivery_error_code: 141006,
      error: '[meta:141006] Payment configuration required', provider_message_id: wamid })
    expect((await current()).delivery_updated_at).toEqual(new Date(1791490000 * 1000))
    expect((await db.query('SELECT * FROM campaigns')).rows).toEqual([{ id: 1, total_sent: 0, total_failed: 0, total_skipped: 1 }])
    expect((await db.query('SELECT status FROM campaign_recipients')).rows).toEqual([{ status: 'skipped' }])
    expect((await db.query('SELECT frequency_released_at,failed_message_id FROM contact_send_history')).rows)
      .toEqual([{ frequency_released_at: null, failed_message_id: null }])
    expect((await finish()).status).toBe('failed')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('durably captures a callback arriving before the HTTP response exposes the provider ID', async () => {
    await handleDeliveryStatus(phoneId, failure(), 'early-webhook')
    expect(await countReceipts()).toBe(1)
    expect(await current()).toMatchObject({ status: 'sending', provider_message_id: null })
    expect(await finish()).toMatchObject({ status: 'failed', delivery_error_code: 141006 })
  })
  it('does not regress delivered/read states or restore a stale failure message', async () => {
    await finish()
    await handleDeliveryStatus(phoneId, failure(), 'test')
    await handleDeliveryStatus(phoneId, event('delivered', { timestamp: '1791490001' }), 'test')
    expect(await current()).toMatchObject({ status: 'delivered', error: null, delivery_error_code: null })
    await handleDeliveryStatus(phoneId, event('sent'), 'test')
    await handleDeliveryStatus(phoneId, failure(999, '1791490010'), 'test')
    expect((await current()).status).toBe('delivered')
    await handleDeliveryStatus(phoneId, event('read', { timestamp: '1791490002' }), 'test')
    await handleDeliveryStatus(phoneId, event('delivered', { timestamp: '1791490011' }), 'test')
    expect(await finish()).toMatchObject({ status: 'read', error: null, delivery_error_code: null })
  })
  it('does not overwrite a known failure with an older failure or sent callback', async () => {
    await finish()
    await recordCampaignTestDelivery(phoneId, failure(141006, '1791490005'))
    await recordCampaignTestDelivery(phoneId, failure(999, '1791490000'))
    await recordCampaignTestDelivery(phoneId, event('sent', { timestamp: '1791490010' }))
    expect(await current()).toMatchObject({ status: 'failed', delivery_error_code: 141006 })
  })
  it('applies repeated callbacks idempotently', async () => {
    await finish()
    await handleDeliveryStatus(phoneId, failure(), 'first')
    const first = await current()
    await handleDeliveryStatus(phoneId, failure(), 'duplicate')
    expect(await current()).toEqual(first)
    expect(await countReceipts()).toBe(1)
  })
  it('requires the sender scope and ignores unrelated WAMIDs after HTTP completion', async () => {
    await finish()
    await recordCampaignTestDelivery('another-sender', failure())
    await recordCampaignTestDelivery(phoneId, { ...failure(), id: 'wamid.unrelated' })
    expect((await current()).status).toBe('sent')
    expect(await countReceipts()).toBe(0)
  })
  it.each(['before', 'after'])('accepts Meta recipient canonicalization %s the HTTP response using exact sender/WAMID', async when => {
    if (when === 'after') await finish()
    await recordCampaignTestDelivery(phoneId, { ...event('delivered'), recipient_id: '541112345678' })
    expect((await finish()).status).toBe('delivered')
  })
  it('isolates identical provider IDs on different sender numbers', async () => {
    await seed(2, 'second-sender')
    await finish(); await finish(2, 'second-sender')
    await recordCampaignTestDelivery(phoneId, failure())
    await recordCampaignTestDelivery('second-sender', event('delivered'))
    expect((await current()).status).toBe('failed')
    expect((await current(2)).status).toBe('delivered')
    expect(await countReceipts()).toBe(2)
  })
  it('does not retain unrelated callbacks after the short in-flight window or unsupported deletion statuses', async () => {
    await db.query("UPDATE campaign_test_sends SET created_at=now()-interval '3 minutes'")
    await recordCampaignTestDelivery(phoneId, event('delivered'))
    await recordCampaignTestDelivery(phoneId, event('deleted'))
    expect(await countReceipts()).toBe(0)
    expect((await current()).status).toBe('sending')
  })
  it('never assigns an unrelated early callback to an attempt by recipient or proximity', async () => {
    await recordCampaignTestDelivery(phoneId, { ...failure(), id: 'wamid.another-message' })
    expect((await finish()).status).toBe('sent')
    expect(await countReceipts()).toBe(1)
  })
  it('preserves an existing failure without a receipt when a stale sent callback arrives', async () => {
    await finish()
    await db.query("UPDATE campaign_test_sends SET status='failed',error='[meta:141006] Confirmed failure'")
    await recordCampaignTestDelivery(phoneId, event('sent'))
    expect(await current()).toMatchObject({ status: 'failed', error: '[meta:141006] Confirmed failure' })
  })
  it('reconciles concurrent callback and HTTP completion whichever takes the lock first', async () => {
    await Promise.all([finish(), recordCampaignTestDelivery(phoneId, failure())])
    expect(await current()).toMatchObject({ status: 'failed', delivery_error_code: 141006 })
    expect(await countReceipts()).toBe(1)
  })
  it('rolls back a receipt and rejects the handler when ledger persistence fails', async () => {
    await finish()
    await db.query(`CREATE FUNCTION fail_test_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic ledger failure'; END $$;
      CREATE TRIGGER fail_delivery BEFORE UPDATE ON campaign_test_sends FOR EACH ROW EXECUTE FUNCTION fail_test_delivery();`)
    try {
      await expect(handleDeliveryStatus(phoneId, failure(), 'retry-required')).rejects.toThrow('Synthetic ledger failure')
      expect(await countReceipts()).toBe(0)
      expect((await current()).status).toBe('sent')
    } finally { await db.query('DROP TRIGGER fail_delivery ON campaign_test_sends; DROP FUNCTION fail_test_delivery()') }
    await handleDeliveryStatus(phoneId, failure(), 'provider-retry')
    expect((await current()).status).toBe('failed')
  })
  it('keeps unresolved sends fenced without guessing their provider ID from the recipient', async () => {
    await recordCampaignTestDelivery(phoneId, failure())
    expect(await completeCampaignTestAttempt(id(1), phoneId, 'uncertain', null, 'No confirmation'))
      .toMatchObject({ status: 'uncertain', provider_message_id: null, error: 'No confirmation' })
    expect(await countReceipts()).toBe(1)
  })
  it('keeps the receipt table server-only with RLS enabled and no public privileges', async () => {
    const result = await db.query(`SELECT relrowsecurity,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(relacl,acldefault('r',relowner))) p WHERE p.grantee=0) AS public_access
      FROM pg_class WHERE oid='campaign_test_delivery_receipts'::regclass`)
    expect(result.rows).toEqual([{ relrowsecurity: true, public_access: false }])
  })
})
