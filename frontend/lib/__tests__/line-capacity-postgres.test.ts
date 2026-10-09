/** @vitest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'

const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: vi.fn() }))
vi.mock('@/lib/cloud-api/rate-limiter', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: vi.fn().mockResolvedValue('synthetic-token') }))
vi.mock('@/lib/cloud-api/repositories/compliance.repository', () => ({ complianceRepository: { isOptedOut: vi.fn().mockResolvedValue(false) } }))
vi.mock('@/lib/cloud-api/repositories/conversation.repository', () => ({ conversationRepository: {
  findWindow: vi.fn().mockImplementation(async () => ({ windowExpiresAt: new Date(Date.now()+60000) })),
} }))
vi.mock('@/lib/cloud-api/infrastructure/message-sender.service', async original => ({
  ...await original<typeof import('@/lib/cloud-api/infrastructure/message-sender.service')>(),
  MessageSenderService: class { send = mocks.send },
}))
import { sendViaCloud, getEligibleLines, getEligibleReplyLines } from '@/lib/campaign-distributor'

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('standalone Cloud capacity on local PostgreSQL, provider mocked', () => {
  let db: Pool
  const schema=`line_capacity_${process.pid}`
  const line={id:'00000000-0000-4000-8000-000000000001',phone_number_id:'123456789'}
  const send=()=>sendViaCloud(line,'+5491112345678',{kind:'text',body:'Synthetic reply'},undefined,{purpose:'conversation_reply',reserveCapacity:true})
  beforeAll(async()=>{
    const url=new URL(process.env.DATABASE_URL!)
    if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
    db=new Pool({connectionString:url.toString(),max:8,options:`-c search_path=${schema},public`})
    await db.query(`CREATE SCHEMA ${schema}`)
    await db.query(`CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_type text DEFAULT 'cloud',
      status text DEFAULT 'active',is_connected bool DEFAULT true,sending_enabled bool DEFAULT true,
      msgs_sent_hour int DEFAULT 0,msgs_sent_today int DEFAULT 0,msg_per_hour int DEFAULT 30,msg_per_day int DEFAULT 50,
      hour_reset_at timestamptz,day_reset_at timestamptz,updated_at timestamptz,allowed_types jsonb,
      evolution_instance text,evolution_url text,priority int DEFAULT 1,last_seen_at timestamptz,personality_config jsonb);
      CREATE TABLE cloud_numbers(id uuid DEFAULT gen_random_uuid(),whatsapp_line_id uuid,phone_number_id text,waba_id text,status text);
      INSERT INTO cloud_numbers(whatsapp_line_id,phone_number_id,waba_id,status) VALUES('${line.id}','${line.phone_number_id}','synthetic-waba','active');`)
    const sql=readFileSync(new URL('../../../db/migrations/001_whatsapp_lines.sql',import.meta.url),'utf8')
    await db.query(sql.match(/CREATE OR REPLACE FUNCTION reset_line_counters_if_due\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/)![0])
    mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  })
  beforeEach(async()=>{
    await db.query('TRUNCATE whatsapp_lines')
    await db.query('INSERT INTO whatsapp_lines(id) VALUES($1)',[line.id])
    mocks.send.mockReset().mockResolvedValue({wamid:'synthetic-message-id'})
  })
  afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}})
  const counters=async()=>(await db.query('SELECT msgs_sent_hour,msgs_sent_today,hour_reset_at,day_reset_at FROM whatsapp_lines')).rows[0]

  it('initializes both deadlines on first reservation and never extends an open window',async()=>{
    await send();const first=await counters()
    expect(first.msgs_sent_hour).toBe(1);expect(first.msgs_sent_today).toBe(1)
    expect(first.hour_reset_at.getTime()-Date.now()).toBeGreaterThan(3590000)
    expect(first.day_reset_at.getTime()-Date.now()).toBeGreaterThan(86390000)
    await send();const second=await counters()
    expect(second).toEqual({...first,msgs_sent_hour:2,msgs_sent_today:2})
  })
  it('releases an expired hour before replying while preserving the active daily quota',async()=>{
    await db.query("UPDATE whatsapp_lines SET msgs_sent_hour=30,msgs_sent_today=40,hour_reset_at=NOW()-INTERVAL '1 second',day_reset_at=NOW()+INTERVAL '2 hours'")
    const before=await counters();await send();const after=await counters()
    expect(after.msgs_sent_hour).toBe(1);expect(after.msgs_sent_today).toBe(41)
    expect(after.day_reset_at).toEqual(before.day_reset_at)
  })
  it('releases both expired quotas before replying',async()=>{
    await db.query("UPDATE whatsapp_lines SET msgs_sent_hour=30,msgs_sent_today=50,hour_reset_at=NOW()-INTERVAL '1 second',day_reset_at=NOW()-INTERVAL '1 second'")
    await send();expect(await counters()).toMatchObject({msgs_sent_hour:1,msgs_sent_today:1})
  })
  it('refreshes expired quotas when selecting campaign and reply lines',async()=>{
    await db.query("UPDATE whatsapp_lines SET msgs_sent_hour=30,hour_reset_at=NOW()-INTERVAL '1 second'")
    expect((await getEligibleReplyLines()).map(l=>l.id)).toEqual([line.id])
    await db.query("UPDATE whatsapp_lines SET msgs_sent_today=50,day_reset_at=NOW()-INTERVAL '1 second'")
    expect((await getEligibleLines()).map(l=>l.id)).toEqual([line.id])
  })
  it('keeps daily exhaustion after the hourly window expires',async()=>{
    await db.query("UPDATE whatsapp_lines SET msgs_sent_hour=30,msgs_sent_today=50,hour_reset_at=NOW()-INTERVAL '1 second',day_reset_at=NOW()+INTERVAL '1 hour'")
    await expect(send()).rejects.toThrow('capacidad para responder')
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('only lets one of eight concurrent reservations take the final slot',async()=>{
    await db.query("UPDATE whatsapp_lines SET msgs_sent_hour=29,msgs_sent_today=49,hour_reset_at=NOW()+INTERVAL '1 hour',day_reset_at=NOW()+INTERVAL '24 hours'")
    const result=await Promise.allSettled(Array.from({length:8},send))
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(await counters()).toMatchObject({msgs_sent_hour:30,msgs_sent_today:50})
  })
  it('does not release reserved quota when the provider outcome is uncertain',async()=>{
    mocks.send.mockRejectedValue(new Error('network timeout'))
    await expect(send()).rejects.toThrow()
    const row=await counters();expect(row.msgs_sent_hour).toBe(1);expect(row.hour_reset_at).not.toBeNull()
  })
  it('does not bypass connection state or a configured zero limit',async()=>{
    await db.query("UPDATE whatsapp_lines SET msg_per_hour=0,hour_reset_at=NOW()-INTERVAL '1 second'")
    await expect(send()).rejects.toThrow('capacidad para responder')
    await db.query('UPDATE whatsapp_lines SET msg_per_hour=30,is_connected=false')
    await expect(send()).rejects.toThrow('capacidad para responder')
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
