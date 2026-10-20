// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), provider: vi.fn(), optedOut: vi.fn(), refresh: vi.fn(), scope: vi.fn(), rate: vi.fn(), token: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/global-opt-out', () => ({ isGloballyOptedOut: mocks.optedOut }))
vi.mock('@/lib/campaign-risk', () => ({ assertCloudSendRiskClear: mocks.scope, CampaignRiskError: class extends Error {} }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/cloud-api/rate-limiter', () => ({ enforceRateLimit: mocks.rate }))
vi.mock('@/lib/cloud-api/meta-risk-refresh', () => ({ refreshOperationalAlertMeta: mocks.refresh }))
vi.mock('@/lib/cloud-api/infrastructure/message-sender.service', () => ({ MessageSenderService: class { send = mocks.provider } }))
import { enqueueCampaignRiskWhatsAppAlerts, getCampaignRiskWhatsAppAlerts, completeCampaignRiskAlert, recordCampaignRiskAlertDelivery, type RiskAlertJob } from '@/lib/campaign-risk-alerts'
import { processCampaignRiskWhatsAppAlerts } from '@/lib/campaign-risk-alert-worker'
import { CampaignRiskError } from '@/lib/campaign-risk'
import { CloudApiError, OptOutError } from '@/lib/cloud-api/errors'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const campaignA = id(1), campaignB = id(2), incidentA = id(10), incidentB = id(11), incidentC = id(12)
const destination = '+15555550123'

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('durable campaign risk WhatsApp outbox on isolated PostgreSQL', () => {
  let db: Pool, admin: Pool
  const schema = `risk_alerts_${randomUUID().replace(/-/g, '')}`
  const transaction = async <T,>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
    const client = await db.connect()
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const enqueue = () => transaction(client => enqueueCampaignRiskWhatsAppAlerts(client, [campaignA, campaignB]))
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.search) throw Error('LOCAL_ONLY')
    admin = new Pool({ connectionString: url.toString(), ssl: false })
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString: url.toString(), ssl: false, max: 8, application_name: schema, options: `-c search_path=${schema},public` })
    await db.query(`CREATE TABLE campaigns(id uuid PRIMARY KEY);
      CREATE TABLE campaign_risk_incidents(id uuid PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES campaigns(id),
        detected_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz);
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_type text DEFAULT 'cloud',status text DEFAULT 'active',is_connected boolean DEFAULT true,sending_enabled boolean DEFAULT true,
        msgs_sent_hour integer DEFAULT 0,msgs_sent_today integer DEFAULT 0,msg_per_hour integer DEFAULT 50,msg_per_day integer DEFAULT 500,
        hour_reset_at timestamptz,day_reset_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE cloud_numbers(phone_number_id text PRIMARY KEY,whatsapp_line_id uuid REFERENCES whatsapp_lines(id),status text DEFAULT 'active');
      CREATE FUNCTION reset_line_counters_if_due() RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number_id text,contact_phone text,status text,last_message_at timestamptz,updated_at timestamptz,UNIQUE(phone_number_id,contact_phone));
      CREATE TABLE cloud_messages(id uuid PRIMARY KEY,conversation_id uuid,phone_number_id text,direction text,message_type text,content jsonb,status text,queued_at timestamptz,template_name text,
        wamid text,sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,error_title text,error_details text);`)
    const migration = readFileSync(new URL('../../../db/migrations/158_campaign_risk_whatsapp_alerts.sql', import.meta.url), 'utf8')
    await db.query(migration); await db.query(migration)
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.transaction.mockImplementation(transaction)
  })
  beforeEach(async () => {
    vi.stubEnv('RISK_ALERT_WHATSAPP_TO', destination)
    vi.stubEnv('RISK_ALERT_WHATSAPP_PHONE_NUMBER_ID', '10001')
    vi.stubEnv('RISK_ALERT_WHATSAPP_TEMPLATE_NAME', 'alerta_seguridad_campana')
    vi.stubEnv('RISK_ALERT_WHATSAPP_LANGUAGE', 'es_AR')
    vi.stubEnv('RISK_ALERT_WHATSAPP_TEMPLATE_ID', '')
    mocks.provider.mockReset().mockResolvedValue({ wamid: 'wamid.alert' })
    mocks.optedOut.mockReset().mockResolvedValue(false)
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.scope.mockReset().mockResolvedValue(undefined)
    mocks.rate.mockReset().mockResolvedValue(undefined)
    mocks.token.mockReset().mockResolvedValue('local-test-only')
    await db.query('DROP TRIGGER IF EXISTS fail_alert_completion ON campaign_risk_whatsapp_alerts')
    await db.query('TRUNCATE campaign_risk_whatsapp_receipts,campaign_risk_whatsapp_alerts,campaign_risk_incidents,campaigns,cloud_messages,cloud_conversations,cloud_numbers,whatsapp_lines CASCADE')
    await db.query('INSERT INTO whatsapp_lines(id) VALUES($1)', [id(100)])
    await db.query("INSERT INTO cloud_numbers(phone_number_id,whatsapp_line_id) VALUES('10001',$1)", [id(100)])
    await db.query('INSERT INTO campaigns(id) VALUES($1),($2)', [campaignA, campaignB])
    await db.query(`INSERT INTO campaign_risk_incidents(id,campaign_id,detected_at) VALUES
      ($1,$4,'2026-10-19T12:00:00Z'),($2,$4,'2026-10-19T12:01:00Z'),($3,$5,'2026-10-19T12:00:00Z')`,
    [incidentA, incidentB, incidentC, campaignA, campaignB])
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    if (db) await db.end()
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end() }
  })

  it('enqueues one alert per unresolved campaign pause even with several simultaneous risk signals', async () => {
    await Promise.all([enqueue(), enqueue(), enqueue()])
    const rows = (await db.query('SELECT campaign_id,incident_id,status FROM campaign_risk_whatsapp_alerts ORDER BY campaign_id')).rows
    expect(rows).toEqual([
      { campaign_id: campaignA, incident_id: incidentA, status: 'pending' },
      { campaign_id: campaignB, incident_id: incidentC, status: 'pending' },
    ])
  })
  it('keeps the notification atomic with the surrounding pause transaction', async () => {
    await expect(transaction(async client => {
      await enqueueCampaignRiskWhatsAppAlerts(client, [campaignA])
      throw Error('Simulated pause transaction failure')
    })).rejects.toThrow('Simulated pause transaction failure')
    expect((await db.query('SELECT count(*)::int AS count FROM campaign_risk_whatsapp_alerts')).rows[0].count).toBe(0)
  })
  it('does not enqueue resolved historical incidents on worker startup', async () => {
    await db.query('UPDATE campaign_risk_incidents SET resolved_at=now()')
    await transaction(client => enqueueCampaignRiskWhatsAppAlerts(client))
    expect((await db.query('SELECT count(*)::int AS count FROM campaign_risk_whatsapp_alerts')).rows[0].count).toBe(0)
  })
  it('allows a new alert only after the prior hold was reviewed and a new incident appeared', async () => {
    await transaction(client => enqueueCampaignRiskWhatsAppAlerts(client, [campaignA]))
    await db.query('UPDATE campaign_risk_incidents SET resolved_at=now() WHERE campaign_id=$1', [campaignA])
    await db.query('INSERT INTO campaign_risk_incidents(id,campaign_id) VALUES($1,$2)', [id(20), campaignA])
    await transaction(client => enqueueCampaignRiskWhatsAppAlerts(client, [campaignA]))
    expect((await db.query('SELECT count(*)::int AS count FROM campaign_risk_whatsapp_alerts WHERE campaign_id=$1', [campaignA])).rows[0].count).toBe(2)
  })
  it.each(['RISK_ALERT_WHATSAPP_TO', 'RISK_ALERT_WHATSAPP_PHONE_NUMBER_ID', 'RISK_ALERT_WHATSAPP_TEMPLATE_NAME', 'RISK_ALERT_WHATSAPP_LANGUAGE'])('does not enqueue with incomplete server configuration: %s', async key => {
    vi.stubEnv(key, '')
    await enqueue()
    expect((await db.query('SELECT count(*)::int AS count FROM campaign_risk_whatsapp_alerts')).rows[0].count).toBe(0)
  })
  it('returns only a safe status summary for the selected campaign', async () => {
    await enqueue()
    await db.query("UPDATE campaign_risk_whatsapp_alerts SET status='blocked',detail_code='private-provider-payload' WHERE campaign_id=$1", [campaignA])
    const alerts = await getCampaignRiskWhatsAppAlerts(campaignA)
    expect(alerts).toHaveLength(1)
    expect(Object.keys(alerts[0]).sort()).toEqual(['detail', 'id', 'incidentId', 'status', 'updatedAt'])
    expect(alerts[0]).toMatchObject({ incidentId: incidentA, status: 'blocked' })
    const serialized = JSON.stringify(alerts)
    expect(serialized).not.toContain('private-provider-payload')
    expect(serialized).not.toContain(destination)
    expect(serialized).not.toContain('10001')
    expect(serialized).not.toContain(incidentC)
  })

  describe('worker delivery fencing and verified receipts', () => {
    beforeEach(async () => {
      await db.query('DELETE FROM campaign_risk_incidents WHERE campaign_id=$1', [campaignB])
    })
    const row = async () => (await db.query('SELECT * FROM campaign_risk_whatsapp_alerts WHERE campaign_id=$1', [campaignA])).rows[0] as RiskAlertJob & { detail_code: string }
    const receipt = (status: 'sent'|'delivered'|'read'|'failed', over: Record<string, string> = {}) => ({
      id: 'wamid.alert', status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: destination.slice(1), ...over,
    })

    it('two workers send one alert, with durable history visible before calling the provider', async () => {
      let entered!: () => void, release!: () => void
      const sending = new Promise<void>(resolve => { entered = resolve })
      const finish = new Promise<void>(resolve => { release = resolve })
      mocks.provider.mockImplementation(async request => {
        const stored = await row()
        expect(stored.status).toBe('sending')
        const history = (await db.query('SELECT status,content FROM cloud_messages WHERE id=$1', [stored.attempt_token])).rows[0]
        expect(history.status).toBe('queued')
        expect(history.content).toMatchObject({ source: 'campaign_risk_alert', type: 'template' })
        expect(request.campaignId).toBeUndefined()
        expect(request.template.components).toEqual([])
        entered(); await finish
        return { wamid: 'wamid.alert' }
      })
      const first = processCampaignRiskWhatsAppAlerts()
      await sending
      expect(await processCampaignRiskWhatsAppAlerts()).toBe(0)
      release()
      expect(await first).toBe(1)
      expect(mocks.provider).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({ status: 'sent', provider_message_id: 'wamid.alert' })
      expect((await db.query('SELECT msgs_sent_hour,msgs_sent_today FROM whatsapp_lines')).rows[0]).toEqual({ msgs_sent_hour: 1, msgs_sent_today: 1 })
    })
    it('keeps an unapproved/unverifiable template waiting without creating a send attempt', async () => {
      mocks.refresh.mockRejectedValue(new Error('Template is not approved UTILITY'))
      expect(await processCampaignRiskWhatsAppAlerts()).toBe(1)
      expect(await row()).toMatchObject({ status: 'blocked', detail_code: 'preflight_unavailable' })
      expect(mocks.provider).not.toHaveBeenCalled()
      expect((await db.query('SELECT count(*)::int AS count FROM cloud_messages')).rows[0].count).toBe(0)
      expect(await processCampaignRiskWhatsAppAlerts()).toBe(0)
    })
    it('does not send an obsolete alert after its incident was reviewed', async () => {
      await enqueue()
      await db.query('UPDATE campaign_risk_incidents SET resolved_at=now()')
      await processCampaignRiskWhatsAppAlerts()
      expect(await row()).toMatchObject({ status: 'skipped', detail_code: 'incident_resolved' })
      expect(mocks.provider).not.toHaveBeenCalled()
    })
    it('does not silently change a queued alert sender after server configuration changes', async () => {
      await enqueue()
      vi.stubEnv('RISK_ALERT_WHATSAPP_PHONE_NUMBER_ID', '20002')
      await processCampaignRiskWhatsAppAlerts()
      expect(await row()).toMatchObject({ status: 'skipped', phone_number_id: '10001', detail_code: 'configuration_changed' })
      expect(mocks.provider).not.toHaveBeenCalled()
      expect(mocks.refresh).not.toHaveBeenCalled()
    })
    it('respects opt-out without reserving capacity or creating conversation history', async () => {
      mocks.optedOut.mockResolvedValue(true)
      await processCampaignRiskWhatsAppAlerts()
      expect(await row()).toMatchObject({ status: 'skipped', detail_code: 'opted_out' })
      expect(mocks.provider).not.toHaveBeenCalled()
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect((await db.query('SELECT msgs_sent_hour FROM whatsapp_lines')).rows[0].msgs_sent_hour).toBe(0)
    })
    it('keeps a disabled alert sender blocked and never rotates to another line', async () => {
      await db.query('UPDATE whatsapp_lines SET sending_enabled=false')
      await processCampaignRiskWhatsAppAlerts()
      expect(await row()).toMatchObject({ status: 'blocked', detail_code: 'sender_unavailable' })
      expect(mocks.provider).not.toHaveBeenCalled()
      expect(mocks.refresh).not.toHaveBeenCalled()
    })
    it.each([new CampaignRiskError(), new OptOutError(destination)])('preserves a last-mile known no-send rejection as blocked/skipped, not uncertain', async error => {
      mocks.provider.mockRejectedValue(error)
      await processCampaignRiskWhatsAppAlerts()
      expect((await row()).status).toBe(error instanceof OptOutError ? 'skipped' : 'blocked')
      expect((await db.query('SELECT status FROM cloud_messages')).rows[0].status).toBe('failed')
    })
    it.each(['timeout', 'missing-wamid'])('never automatically replays an uncertain provider outcome: %s', async outcome => {
      if (outcome === 'timeout') mocks.provider.mockRejectedValue(new Error('Provider timeout'))
      else mocks.provider.mockResolvedValue({})
      await processCampaignRiskWhatsAppAlerts()
      expect(await row()).toMatchObject({ status: 'uncertain', detail_code: 'provider_uncertain' })
      expect(await processCampaignRiskWhatsAppAlerts()).toBe(0)
      expect(mocks.provider).toHaveBeenCalledTimes(1)
    })
    it('keeps accepted-but-unpersisted sends fenced after a restart', async () => {
      await db.query(`CREATE OR REPLACE FUNCTION reject_alert_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='sent' THEN RAISE EXCEPTION 'Synthetic completion failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_alert_completion BEFORE UPDATE ON campaign_risk_whatsapp_alerts FOR EACH ROW EXECUTE FUNCTION reject_alert_completion()`)
      await expect(processCampaignRiskWhatsAppAlerts()).rejects.toThrow('Synthetic completion failure')
      expect((await row()).status).toBe('sending')
      await db.query("UPDATE campaign_risk_whatsapp_alerts SET started_at=now()-interval '6 minutes'")
      expect(await processCampaignRiskWhatsAppAlerts()).toBe(0)
      expect(await row()).toMatchObject({ status: 'uncertain', detail_code: 'provider_uncertain' })
      expect(mocks.provider).toHaveBeenCalledTimes(1)
    })
    it('safely reclaims an interrupted preparation before the provider fence', async () => {
      await enqueue()
      await db.query("UPDATE campaign_risk_whatsapp_alerts SET status='preparing',attempt_token=$1,started_at=now()-interval '6 minutes'", [id(500)])
      await processCampaignRiskWhatsAppAlerts()
      expect((await row()).status).toBe('sent')
      expect((await row()).attempt_token).not.toBe(id(500))
      expect(mocks.provider).toHaveBeenCalledTimes(1)
    })
    it('does not retry a definite nonretryable provider rejection', async () => {
      mocks.provider.mockRejectedValue(new CloudApiError('Rejected', 131031))
      await processCampaignRiskWhatsAppAlerts()
      expect(await row()).toMatchObject({ status: 'failed', detail_code: 'provider_rejected' })
      expect(await processCampaignRiskWhatsAppAlerts()).toBe(0)
      expect(mocks.provider).toHaveBeenCalledTimes(1)
    })
    it('can retry an explicitly rejected rate limit with a distinct durable attempt', async () => {
      mocks.provider.mockRejectedValueOnce(new CloudApiError('Rate limit', 130429)).mockResolvedValueOnce({ wamid: 'wamid.alert' })
      await processCampaignRiskWhatsAppAlerts()
      const first = await row()
      expect(first.status).toBe('blocked')
      await db.query('UPDATE campaign_risk_whatsapp_alerts SET next_attempt_at=now()')
      await processCampaignRiskWhatsAppAlerts()
      expect((await row()).status).toBe('sent')
      expect((await row()).attempt_token).not.toBe(first.attempt_token)
      expect((await db.query('SELECT status FROM cloud_messages ORDER BY queued_at')).rows).toEqual([{ status: 'failed' }, { status: 'sent' }])
    })
    it.each(['delivered', 'read'] as const)('reconciles an early %s receipt before HTTP completion and resists later failures', async status => {
      mocks.provider.mockImplementation(async () => {
        await recordCampaignRiskAlertDelivery('10001', receipt(status))
        return { wamid: 'wamid.alert' }
      })
      await processCampaignRiskWhatsAppAlerts()
      expect((await row()).status).toBe(status)
      await recordCampaignRiskAlertDelivery('10001', receipt('failed'))
      await recordCampaignRiskAlertDelivery('10001', receipt('sent'))
      expect((await row()).status).toBe(status)
      expect((await db.query('SELECT status FROM cloud_messages')).rows[0].status).toBe(status)
    })
    it('does not apply a delivery callback from another sender or recipient', async () => {
      await processCampaignRiskWhatsAppAlerts()
      await recordCampaignRiskAlertDelivery('20002', receipt('read'))
      await recordCampaignRiskAlertDelivery('10001', receipt('read', { recipient_id: '15555550999' }))
      expect((await row()).status).toBe('sent')
      expect((await db.query('SELECT count(*)::int AS count FROM campaign_risk_whatsapp_receipts')).rows[0].count).toBe(0)
    })
    it('does not let an old attempt overwrite the current worker reservation', async () => {
      await enqueue()
      const job = { ...await row(), attempt_token: id(501) }
      await db.query("UPDATE campaign_risk_whatsapp_alerts SET status='sending',attempt_token=$1", [id(502)])
      await completeCampaignRiskAlert(job, { status: 'failed', detailCode: 'provider_rejected' })
      expect((await row()).status).toBe('sending')
      expect((await row()).attempt_token).toBe(id(502))
    })
  })
})
