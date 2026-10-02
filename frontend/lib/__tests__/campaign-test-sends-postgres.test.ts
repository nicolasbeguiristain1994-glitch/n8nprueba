/** @vitest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), send: vi.fn(), frequency: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/campaign-distributor', async original => ({
  ...await original<typeof import('@/lib/campaign-distributor')>(), sendViaCloud: mocks.send,
}))
vi.mock('@/lib/contact-frequency/ContactFrequencyEngine', () => ({ ContactFrequencyEngine: { atomicEvaluateAndRecord: mocks.frequency } }))
import { getCampaignTestSnapshot, sendCampaignTest } from '@/lib/campaign-test-sends'
import { CloudSendOutcomeUnknownError } from '@/lib/campaign-distributor'
import { CloudApiError, OptOutError } from '@/lib/cloud-api/errors'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const campaignId = id(1), recipientId = id(2), lineId = id(3), templateId = id(4), userId = id(5)
const input = (n = 10) => ({ request_id: id(n), recipient_id: recipientId, line_id: lineId })

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('campaign test sends on isolated PostgreSQL schema', () => {
  let db: Pool
  let admin: Pool
  const schema = `campaign_test_${randomUUID().replace(/-/g, '')}`
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('LOCAL_ONLY')
    admin = new Pool({ connectionString: url.toString(), ssl: false })
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString: url.toString(), ssl: false, options: `-c search_path=${schema},public`, max: 4 })
    await db.query(`
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE campaigns(id uuid PRIMARY KEY, message_type text, template_id uuid, template_params jsonb,
        status text DEFAULT 'running', total_sent int DEFAULT 0, total_skipped int DEFAULT 2);
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY, name text, language text, waba_id text, status text, components jsonb);
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY, display_name text, line_key text, line_type text,
        status text, is_connected boolean, sending_enabled boolean, msgs_sent_hour int, msg_per_hour int,
        msgs_sent_today int, msg_per_day int, allowed_types jsonb, priority int);
      CREATE TABLE cloud_numbers(whatsapp_line_id uuid, status text, waba_id text, phone_number_id text);
      CREATE TABLE blacklist(phone_number_normalized text, removed_at timestamptz);
      CREATE TABLE contacts(phone_number text, do_not_contact boolean);
      CREATE TABLE contact_send_history(id int PRIMARY KEY, phone_number text);
      CREATE TABLE campaign_recipients(id int PRIMARY KEY, status text);
    `)
    const migration = readFileSync(new URL('../../../db/migrations/136_campaign_test_sends.sql', import.meta.url), 'utf8')
    await db.query(migration)
    await db.query(migration)
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.transaction.mockImplementation(async fn => {
      const client = await db.connect()
      try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    })
  })
  beforeEach(async () => {
    mocks.send.mockReset().mockResolvedValue({ messageId: 'wamid.test' })
    mocks.frequency.mockReset().mockRejectedValue(new Error('Contact frequency must not be invoked for test sends'))
    await db.query(`TRUNCATE campaign_test_sends, campaign_test_recipients, users, campaigns, whatsapp_lines,
      whatsapp_templates, cloud_numbers, blacklist, contacts, contact_send_history, campaign_recipients CASCADE`)
    await db.query('INSERT INTO users VALUES ($1)', [userId])
    await db.query(`INSERT INTO campaigns(id,message_type,template_id,template_params) VALUES ($1,'template',$2,'{"body":["{{first_name}}"]}')`, [campaignId, templateId])
    await db.query(`INSERT INTO whatsapp_templates VALUES ($1,'regalo3000','es_AR','waba-1','APROBADA','[{"type":"BODY","text":"Hola {{1}}"}]')`, [templateId])
    await db.query(`INSERT INTO campaign_test_recipients(id,first_name,phone_number,created_by) VALUES ($1,'pablo','+5491112345678',$2)`, [recipientId, userId])
    await db.query(`INSERT INTO whatsapp_lines VALUES ($1,'Solbatt','test_line','cloud','active',true,true,0,50,0,500,'["campaign"]',1)`, [lineId])
    await db.query(`INSERT INTO cloud_numbers VALUES ($1,'active','waba-1','123456789')`, [lineId])
    await db.query(`INSERT INTO contact_send_history VALUES (1,'+5491112345678'); INSERT INTO campaign_recipients VALUES (1,'skipped')`)
  })
  afterAll(async () => {
    if (db) await db.end()
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end() }
  })

  it('uses the stored recipient name and records a test without changing frequency history or campaign metrics', async () => {
    const result = await sendCampaignTest(campaignId, input(), userId)
    expect(result.status).toBe('sent')
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ id: lineId }), '+5491112345678',
      expect.objectContaining({ content: expect.objectContaining({ components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Pablo' }] },
      ] }) }), undefined, { reserveCapacity: true })
    expect(mocks.frequency).not.toHaveBeenCalled()
    expect((await db.query('SELECT * FROM contact_send_history')).rows).toEqual([{ id: 1, phone_number: '+5491112345678' }])
    expect((await db.query('SELECT * FROM campaign_recipients')).rows).toEqual([{ id: 1, status: 'skipped' }])
    expect((await db.query('SELECT status,total_sent,total_skipped FROM campaigns')).rows[0]).toEqual({ status: 'running', total_sent: 0, total_skipped: 2 })
    expect((await getCampaignTestSnapshot(campaignId)).attempts).toHaveLength(1)
  })
  it('serializes concurrent requests with the same key and never sends twice', async () => {
    const [a, b] = await Promise.all([sendCampaignTest(campaignId, input(), userId), sendCampaignTest(campaignId, input(), userId)])
    expect(a.id).toBe(b.id)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect((await db.query('SELECT count(*)::int AS n FROM campaign_test_sends')).rows[0].n).toBe(1)
    await sendCampaignTest(campaignId, input(), userId)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('also blocks rapid duplicate clicks that carry different request keys', async () => {
    const results = await Promise.allSettled([sendCampaignTest(campaignId, input(10), userId), sendCampaignTest(campaignId, input(11), userId)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('allows a deliberate later test and keeps both records', async () => {
    await sendCampaignTest(campaignId, input(10), userId)
    await db.query("UPDATE campaign_test_sends SET created_at=now()-interval '11 seconds'")
    await sendCampaignTest(campaignId, input(11), userId)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect((await getCampaignTestSnapshot(campaignId)).attempts).toHaveLength(2)
  })
  it('rejects inactive or unregistered recipients before any send', async () => {
    await db.query('UPDATE campaign_test_recipients SET active=false')
    await expect(sendCampaignTest(campaignId, input(), userId)).rejects.toMatchObject({ status: 403 })
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it.each(['waba', 'quota', 'disabled', 'template'])('keeps %s restrictions in place', async reason => {
    if (reason === 'waba') await db.query("UPDATE cloud_numbers SET waba_id='other'")
    if (reason === 'quota') await db.query('UPDATE whatsapp_lines SET msgs_sent_today=msg_per_day')
    if (reason === 'disabled') await db.query('UPDATE whatsapp_lines SET sending_enabled=false')
    if (reason === 'template') await db.query("UPDATE whatsapp_templates SET status='RECHAZADA'")
    await expect(sendCampaignTest(campaignId, input(), userId)).rejects.toMatchObject({ status: 409 })
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it.each(['blacklist', 'optout'])('honors the local %s', async reason => {
    if (reason === 'blacklist') await db.query("INSERT INTO blacklist VALUES ('5491112345678',NULL)")
    else await db.query("INSERT INTO contacts VALUES ('+549 11 1234-5678',true)")
    await expect(sendCampaignTest(campaignId, input(), userId)).rejects.toMatchObject({ status: 422 })
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it.each([new CloudApiError('Rejected', 132000), new OptOutError('synthetic')])('records confirmed errors and never retries the same request', async error => {
    mocks.send.mockRejectedValue(error)
    expect((await sendCampaignTest(campaignId, input(), userId)).status).toBe('failed')
    expect((await sendCampaignTest(campaignId, input(), userId)).status).toBe('failed')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('retains an ambiguous attempt without automatic resend', async () => {
    mocks.send.mockRejectedValue(new CloudSendOutcomeUnknownError())
    expect((await sendCampaignTest(campaignId, input(), userId)).status).toBe('uncertain')
    expect((await sendCampaignTest(campaignId, input(), userId)).status).toBe('uncertain')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('leaves a durable fence if storing the final status fails after Meta accepted', async () => {
    mocks.query.mockRejectedValueOnce(new Error('synthetic storage failure'))
    expect((await sendCampaignTest(campaignId, input(), userId)).status).toBe('uncertain')
    expect((await sendCampaignTest(campaignId, input(), userId)).status).toBe('sending')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('does not contact Meta if the attempt cannot be persisted first', async () => {
    await expect(sendCampaignTest(campaignId, input(), id(999))).rejects.toBeDefined() // user FK fails
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('rejects a reused request key with different recipients or lines', async () => {
    await sendCampaignTest(campaignId, input(), userId)
    await expect(sendCampaignTest(campaignId, { ...input(), line_id: id(999) }, userId)).rejects.toMatchObject({ status: 409 })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})
