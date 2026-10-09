/** @vitest-environment node */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
import { prepareCampaignRouting, getCampaignAssignedLine } from '@/lib/campaign-routing'
import { claimNextUnit } from '@/lib/campaign-distributor'
import { claimOne } from '@/lib/send-processor'

const enabled = process.env.RUN_CAMPAIGN_PG_TESTS === '1'
const id = (n: number) => `00000001-0000-0000-0000-${String(n).padStart(12, '0')}`
const owner = id(1), otherOwner = id(2), a = id(11), b = id(12), campaign = id(21), nextCampaign = id(22)
const phone = (n: number) => `+54911${String(n).padStart(8,'0')}`

describe.skipIf(!enabled)('campaign routing on real PostgreSQL (no provider requests)', () => {
  let pool: Pool
  const schema = `routing_test_${process.pid}`
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Local database required')
    pool = new Pool({ connectionString: url.toString(), max: 8, options: `-c search_path=${schema},public` })
    await pool.query(`CREATE SCHEMA ${schema}`)
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,owner_user_id uuid);
      CREATE TABLE campaigns(id uuid PRIMARY KEY, owned_by uuid, use_multi_line bool DEFAULT false,pause_reason text);
      CREATE TABLE contacts(id uuid PRIMARY KEY,first_name text);
      CREATE TABLE prospects(id uuid PRIMARY KEY,first_name text);
      CREATE TABLE campaign_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid,
        contact_id uuid,prospect_id uuid, phone_number text,status text DEFAULT 'pending',line_id uuid,
        sent_at timestamptz,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),
        locked_at timestamptz,attempts int DEFAULT 0);
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY,contact_phone text);
      CREATE TABLE cloud_numbers(phone_number_id text PRIMARY KEY,whatsapp_line_id uuid);
      CREATE TABLE cloud_messages(conversation_id uuid,phone_number_id text,direction text,status text,
        sent_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE phone_line_assignments(phone text PRIMARY KEY,line_id uuid,updated_at timestamptz);
      CREATE FUNCTION get_accessible_line_ids(actor uuid) RETURNS SETOF uuid LANGUAGE sql AS
        'SELECT id FROM whatsapp_lines WHERE owner_user_id=actor';
    `)
    const sql = readFileSync(new URL('../../../db/migrations/138_campaign_sender_affinity.sql', import.meta.url),'utf8')
    await pool.query(sql)
    await pool.query(sql)
    mocks.query.mockImplementation(async (sql, params) => (await pool.query(sql,params)).rows)
    mocks.transaction.mockImplementation(async fn => {
      const client=await pool.connect()
      try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result }
      catch (e) { await client.query('ROLLBACK'); throw e }
      finally { client.release() }
    })
  })
  afterEach(async () => {
    await pool.query(`TRUNCATE campaign_line_assignments,campaign_line_rotation,campaign_recipients,
      campaigns,whatsapp_lines,cloud_messages,cloud_conversations,cloud_numbers,phone_line_assignments CASCADE`)
  })
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end() }
  })
  async function seed() {
    await pool.query('INSERT INTO whatsapp_lines VALUES($1,$3),($2,$3)',[a,b,owner])
    await pool.query('INSERT INTO campaigns(id,owned_by) VALUES($1,$3),($2,$3)',[campaign,nextCampaign,owner])
  }
  async function recipient(c: string,n: number,line: string|null=null,status='pending',at='2026-09-01') {
    await pool.query(`INSERT INTO campaign_recipients(campaign_id,phone_number,line_id,status,sent_at)
      VALUES($1,$2,$3,$4,$5)`,[c,phone(n),line,status,at])
  }
  it('allocates 500 new customers evenly and is idempotent', async () => {
    await seed()
    await pool.query(`INSERT INTO campaign_recipients(campaign_id,phone_number)
      SELECT $1,'+54911'||lpad(n::text,8,'0') FROM generate_series(1,500) n`,[campaign])
    await prepareCampaignRouting(campaign,[b,a]); await prepareCampaignRouting(campaign,[a,b])
    expect((await pool.query('SELECT line_id,COUNT(*)::int n FROM campaign_line_assignments GROUP BY line_id ORDER BY line_id')).rows)
      .toEqual([{line_id:a,n:250},{line_id:b,n:250}])
    expect((await pool.query('SELECT next_position::int n FROM campaign_line_rotation')).rows[0].n).toBe(500)
  })
  it('uses the last successful campaign sender and keeps it even when not eligible', async () => {
    await seed(); await recipient(nextCampaign,1,a,'sent','2026-09-01')
    await recipient(nextCampaign,1,b,'sent','2026-09-02'); await recipient(nextCampaign,1,a,'failed','2026-09-03')
    await recipient(campaign,1); await recipient(campaign,2)
    await prepareCampaignRouting(campaign,[a])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(b)
    const claim=await claimNextUnit(campaign,a)
    expect(claim?.phone_number).toBe(phone(2))
    expect(await claimNextUnit(campaign,a)).toBeNull()
    expect((await pool.query('SELECT status,attempts FROM campaign_recipients WHERE campaign_id=$1 AND phone_number=$2',[campaign,phone(1)])).rows[0])
      .toEqual({status:'pending',attempts:0})
    expect((await claimNextUnit(campaign,b))?.phone_number).toBe(phone(1))
  })
  it('recovers the Cloud inbox sender even when that line is unavailable', async () => {
    await seed(); await recipient(campaign,1)
    await pool.query('INSERT INTO cloud_numbers VALUES($1,$2)',['phone-b',b])
    await pool.query('INSERT INTO cloud_conversations VALUES($1,$2)',[id(31),phone(1).slice(1)])
    await pool.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,direction,status)
      VALUES($1,'phone-b','outbound','delivered')`,[id(31)])
    await prepareCampaignRouting(campaign,[a])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(b)
  })
  it('keeps one assignment for normalized phones, contacts and prospects across campaigns', async () => {
    await seed(); await recipient(campaign,1)
    await prepareCampaignRouting(campaign,[a,b])
    await pool.query(`INSERT INTO campaign_recipients(campaign_id,phone_number,prospect_id)
      VALUES($1,$2,$3)`,[nextCampaign,'+54 (911) 0000-0001',id(51)])
    await prepareCampaignRouting(nextCampaign,[b,a])
    expect(await getCampaignAssignedLine(nextCampaign,phone(1))).toBe(a)
    expect((await pool.query('SELECT COUNT(*)::int n FROM campaign_line_assignments')).rows[0].n).toBe(1)
  })
  it('serializes overlapping campaigns and rotates across small successive campaigns', async () => {
    await seed(); await recipient(campaign,1); await recipient(nextCampaign,1); await recipient(nextCampaign,2)
    await Promise.all([prepareCampaignRouting(campaign,[a,b]),prepareCampaignRouting(nextCampaign,[b,a])])
    const rows=(await pool.query('SELECT phone,line_id FROM campaign_line_assignments ORDER BY phone')).rows
    expect(rows).toEqual([{phone:phone(1).slice(1),line_id:a},{phone:phone(2).slice(1),line_id:b}])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(await getCampaignAssignedLine(nextCampaign,phone(1)))
  })
  it('repairs a deleted sender through rotation without changing surviving assignments', async () => {
    await seed(); await recipient(campaign,1); await prepareCampaignRouting(campaign,[a])
    await recipient(campaign,2); await prepareCampaignRouting(campaign,[b])
    await pool.query('DELETE FROM whatsapp_lines WHERE id=$1',[a])
    await prepareCampaignRouting(campaign,[b])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(b)
    expect(await getCampaignAssignedLine(campaign,phone(2))).toBe(b)
    expect((await claimNextUnit(campaign,b))?.phone_number).toBe(phone(1))
    const before=(await pool.query('SELECT * FROM campaign_line_assignments ORDER BY phone')).rows
    await prepareCampaignRouting(campaign,[b])
    expect((await pool.query('SELECT * FROM campaign_line_assignments ORDER BY phone')).rows).toEqual(before)
  })
  it('recovers a surviving historical sender after deletion even when it is not eligible', async () => {
    await seed(); await recipient(campaign,1); await prepareCampaignRouting(campaign,[a])
    await recipient(nextCampaign,1,b,'sent')
    await pool.query('DELETE FROM whatsapp_lines WHERE id=$1',[a])
    const fresh=id(13); await pool.query('INSERT INTO whatsapp_lines VALUES($1,$2)',[fresh,owner])
    await prepareCampaignRouting(campaign,[fresh])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(b)
    expect(await claimNextUnit(campaign,fresh)).toBeNull()
    expect((await pool.query('SELECT source FROM campaign_line_assignments')).rows).toEqual([{source:'history'}])
  })
  it('ignores deleted and inaccessible campaign history when repairing a sender',async()=>{
    await seed(); await recipient(campaign,1); await prepareCampaignRouting(campaign,[a])
    await recipient(nextCampaign,1,a,'sent')
    await pool.query('DELETE FROM whatsapp_lines WHERE id=$1',[a])
    const other=id(13); await pool.query('INSERT INTO whatsapp_lines VALUES($1,$2)',[other,otherOwner])
    await recipient(nextCampaign,1,other,'sent','2026-10-01')
    await prepareCampaignRouting(campaign,[b])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(b)
  })
  it('repairs overlapping campaigns once and leaves unrelated owners unchanged',async()=>{
    await seed(); await recipient(campaign,1); await recipient(nextCampaign,1)
    await prepareCampaignRouting(campaign,[a])
    await pool.query('DELETE FROM whatsapp_lines WHERE id=$1',[a])
    await pool.query("INSERT INTO campaign_line_assignments(owner_key,phone,line_id,source) VALUES($1,$2,NULL,'rotation')",[otherOwner,phone(1).slice(1)])
    await Promise.all([prepareCampaignRouting(campaign,[b]),prepareCampaignRouting(nextCampaign,[b])])
    expect(await getCampaignAssignedLine(campaign,phone(1))).toBe(b)
    expect(await getCampaignAssignedLine(nextCampaign,phone(1))).toBe(b)
    expect((await pool.query('SELECT next_position::int n FROM campaign_line_rotation WHERE owner_key=$1',[owner])).rows[0].n).toBe(2)
    expect((await pool.query('SELECT line_id FROM campaign_line_assignments WHERE owner_key=$1',[otherOwner])).rows[0].line_id).toBeNull()
  })
  it('keeps ownership scopes isolated and imports only accessible inbox/legacy lines', async () => {
    await seed(); await recipient(campaign,1,a,'sent')
    await pool.query('UPDATE campaigns SET owned_by=$1 WHERE id=$2',[otherOwner,nextCampaign])
    await pool.query('INSERT INTO whatsapp_lines VALUES($1,$2)',[id(13),otherOwner])
    await pool.query('INSERT INTO phone_line_assignments VALUES($1,$2,NOW())',[phone(1),a])
    await recipient(nextCampaign,1); await prepareCampaignRouting(nextCampaign,[id(13)])
    expect(await getCampaignAssignedLine(nextCampaign,phone(1))).toBe(id(13))
  })
  it('does not double claim recipients with concurrent workers and supports the legacy processor', async () => {
    await seed(); for(let n=1;n<=4;n++) await recipient(campaign,n)
    await prepareCampaignRouting(campaign,[a,b])
    const claims=await Promise.all([claimNextUnit(campaign,a),claimNextUnit(campaign,a),claimNextUnit(campaign,b),claimNextUnit(campaign,b)])
    expect(new Set(claims.map(x=>x?.id)).size).toBe(4)
    expect(claims.every(Boolean)).toBe(true)
    expect(await claimOne(campaign,[a,b])).toBeUndefined()
    await recipient(nextCampaign,1);await prepareCampaignRouting(nextCampaign,[a,b])
    expect(await claimOne(nextCampaign,[b])).toBeUndefined()
    expect((await claimOne(nextCampaign,[a]))?.phone_number).toBe(phone(1))
  })

  async function seedEight() {
    await seed()
    const lines=Array.from({length:8},(_,i)=>id(11+i))
    for(const line of lines.slice(2))await pool.query('INSERT INTO whatsapp_lines VALUES($1,$2)',[line,owner])
    return lines
  }
  async function addSyntheticRecipients(c:string,start:number,count:number) {
    await pool.query(`INSERT INTO campaign_recipients(campaign_id,phone_number)
      SELECT $1,'+54911'||lpad(n::text,8,'0') FROM generate_series($2::int,$3::int) n`,[c,start,start+count-1])
  }
  it('Nexus audit: assigns 800 fresh destinations equally across eight lines and does not consume rotation twice',async()=>{
    const lines=await seedEight();await addSyntheticRecipients(campaign,1,800)
    await prepareCampaignRouting(campaign,[...lines].reverse());await prepareCampaignRouting(campaign,lines)
    const counts=(await pool.query('SELECT line_id,count(*)::int n FROM campaign_line_assignments GROUP BY line_id ORDER BY line_id')).rows
    expect(counts).toEqual(lines.map(line_id=>({line_id,n:100})))
    const first=(await pool.query('SELECT line_id FROM campaign_line_assignments ORDER BY phone LIMIT 16')).rows.map(r=>r.line_id)
    expect(first).toEqual([...lines,...lines])
    expect((await pool.query('SELECT next_position::int n FROM campaign_line_rotation')).rows[0].n).toBe(800)
  })
  it('Nexus audit: two rounds of eight parallel workers claim sixteen unique messages without changing assigned senders',async()=>{
    const lines=await seedEight();await addSyntheticRecipients(campaign,1,16)
    await prepareCampaignRouting(campaign,lines)
    const claimed=[]
    for(let round=0;round<2;round++)claimed.push(...await Promise.all(lines.map(async line=>({line,unit:await claimNextUnit(campaign,line)}))))
    expect(claimed.every(row=>row.unit)).toBe(true)
    expect(new Set(claimed.map(row=>row.unit!.id)).size).toBe(16)
    for(const row of claimed)expect(await getCampaignAssignedLine(campaign,row.unit!.phone_number)).toBe(row.line)
    expect(await Promise.all(lines.map(line=>claimNextUnit(campaign,line)))).toEqual(Array(8).fill(null))
  })
  it('Nexus audit: adding five lines preserves old contacts and distributes only new contacts across all eight',async()=>{
    const lines=await seedEight();await addSyntheticRecipients(campaign,1,24)
    await prepareCampaignRouting(campaign,lines.slice(0,3))
    const before=(await pool.query('SELECT phone,line_id FROM campaign_line_assignments ORDER BY phone')).rows
    await prepareCampaignRouting(campaign,lines)
    expect((await pool.query('SELECT phone,line_id FROM campaign_line_assignments ORDER BY phone')).rows).toEqual(before)
    await addSyntheticRecipients(nextCampaign,25,16);await prepareCampaignRouting(nextCampaign,lines)
    const newCounts=(await pool.query('SELECT line_id,count(*)::int n FROM campaign_line_assignments WHERE phone>$1 GROUP BY line_id ORDER BY line_id',[phone(24).slice(1)])).rows
    expect(newCounts).toEqual(lines.map(line_id=>({line_id,n:2})))
  })
  it('Nexus audit: unavailable assigned senders leave their contacts pending without switching numbers',async()=>{
    const lines=await seedEight();await addSyntheticRecipients(campaign,1,16)
    await prepareCampaignRouting(campaign,lines)
    const available=lines.slice(0,3)
    for(let round=0;round<2;round++)await Promise.all(available.map(line=>claimNextUnit(campaign,line)))
    await prepareCampaignRouting(campaign,available)
    expect(await Promise.all(available.map(line=>claimNextUnit(campaign,line)))).toEqual([null,null,null])
    expect((await pool.query("SELECT count(*)::int n FROM campaign_recipients WHERE status='pending'")).rows[0].n).toBe(10)
  })
})
