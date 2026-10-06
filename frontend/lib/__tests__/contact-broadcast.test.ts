// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { contactBroadcastClause } from '../contact-broadcast'
import { readBroadcastRange, broadcastParams } from '../broadcast-range'
import { savedAudienceParams } from '../dynamic-audiences'

const sp = (s:string) => new URLSearchParams(s)
describe('Broadcast period validation',()=>{
  it.each(['difusion=x&difusion_dias=7','difusion=sent&difusion_dias=0','difusion=sent&difusion_dias=7.2','difusion=sent&difusion_dias=36501','difusion=sent','difusion_dias=7','difusion=sent&difusion_desde=2026-02-30&difusion_hasta=2026-03-01','difusion=sent&difusion_desde=2026-10-07&difusion_hasta=2026-10-06','difusion=sent&difusion_dias=7&difusion_desde=2026-10-06'])('rejects %s',q=>expect(()=>readBroadcastRange(sp(q))).toThrow())
  it('preserves the relative interval in a saved dynamic audience',()=>{
    const p=broadcastParams(readBroadcastRange(sp('difusion=not_sent&difusion_dias=7')))
    expect(savedAudienceParams(p).toString()).toBe('difusion=not_sent&difusion_dias=7')
    expect(contactBroadcastClause(savedAudienceParams(p),()=>'$1')).toContain('CURRENT_TIMESTAMP')
  })
  it('does not query history with the filter off',()=>expect(contactBroadcastClause(sp(''),()=>'$1')).toBeNull())
})
const url=process.env.CONTACTS_TEST_DATABASE_URL
describe.skipIf(!url)('Broadcast history on PostgreSQL',()=>{
  let c:Client
  const schema=`broadcast_filter_${process.pid}`
  beforeAll(async()=>{
    const u=new URL(url!)
    if(!['127.0.0.1','localhost'].includes(u.hostname)||u.search) throw Error('Local tests only')
    c=new Client({host:u.hostname,port:Number(u.port||5432),user:u.username,password:u.password,database:u.pathname.slice(1)})
    await c.connect()
    await c.query(`CREATE SCHEMA ${schema}; SET search_path=${schema};
      CREATE TABLE contacts(id integer,phone_number text);
      CREATE TABLE whatsapp_messages(phone_number text,campaign_id integer,direction text,status text,sent_at timestamptz,created_at timestamptz);
      CREATE TABLE campaign_recipients(phone_number text,campaign_id integer,status text,sent_at timestamptz);
      INSERT INTO contacts SELECT n,'+54911000000'||lpad(n::text,2,'0') FROM generate_series(1,12) n;
      INSERT INTO whatsapp_messages SELECT phone_number,1,'outbound',CASE id WHEN 2 THEN 'failed' WHEN 3 THEN 'queued' WHEN 4 THEN 'read' ELSE 'sent' END,
        CASE id WHEN 5 THEN '2026-10-06 02:59:59Z'::timestamptz WHEN 6 THEN '2026-10-07 03:00:00Z'::timestamptz ELSE '2026-10-06 03:00:00Z'::timestamptz END,'2026-10-06 03:00:00Z'
        FROM contacts WHERE id<=6;
      INSERT INTO whatsapp_messages SELECT phone_number,NULL,'outbound','sent','2026-10-06 12:00Z','2026-10-06 12:00Z' FROM contacts WHERE id=7;
      INSERT INTO campaign_recipients SELECT phone_number,1,'sent','2026-10-06 12:00Z' FROM contacts WHERE id IN (2,3,8);
      INSERT INTO whatsapp_messages SELECT replace(phone_number,'+',''),2,'outbound','delivered','2026-10-06 12:00Z','2026-10-06 12:00Z' FROM contacts WHERE id=9;
      INSERT INTO whatsapp_messages SELECT phone_number,2,'inbound','read','2026-10-06 12:00Z','2026-10-06 12:00Z' FROM contacts WHERE id=10;
      INSERT INTO whatsapp_messages SELECT phone_number,3,'outbound','failed','2026-10-06 14:00Z','2026-10-06 14:00Z' FROM contacts WHERE id=4;
      INSERT INTO whatsapp_messages VALUES(NULL,1,'outbound','sent','2026-10-06 12:00Z','2026-10-06 12:00Z');`)
  })
  afterAll(async()=>{if(c){await c.query('ROLLBACK');await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end()}})
  async function ids(q:string){const params:unknown[]=[];const sql=contactBroadcastClause(sp(q),v=>{params.push(v);return `$${params.length}`});return (await c.query(`SELECT id FROM contacts WHERE ${sql} ORDER BY id`,params)).rows.map(r=>r.id)}
  it('includes both Argentine calendar boundaries; only successful outbound campaigns and legacy evidence',async()=>{
    expect(await ids('difusion=sent&difusion_desde=2026-10-06&difusion_hasta=2026-10-06')).toEqual([1,4,8,9])
  })
  it('not sent is the exact complement, including never sent, without NULL poisoning',async()=>{
    expect(await ids('difusion=not_sent&difusion_desde=2026-10-06&difusion_hasta=2026-10-06')).toEqual([2,3,5,6,7,10,11,12])
  })
  it('rolling seven days includes the lower boundary and excludes older/future sends',async()=>{
    await c.query('BEGIN')
    try{
      await c.query(`TRUNCATE whatsapp_messages,campaign_recipients;
        INSERT INTO whatsapp_messages SELECT phone_number,1,'outbound','sent',CURRENT_TIMESTAMP - interval '7 days',CURRENT_TIMESTAMP FROM contacts WHERE id=1;
        INSERT INTO whatsapp_messages SELECT phone_number,1,'outbound','sent',CURRENT_TIMESTAMP - interval '7 days 1 second',CURRENT_TIMESTAMP FROM contacts WHERE id=2;
        INSERT INTO whatsapp_messages SELECT phone_number,1,'outbound','sent',CURRENT_TIMESTAMP + interval '1 second',CURRENT_TIMESTAMP FROM contacts WHERE id=3;`)
      expect(await ids('difusion=sent&difusion_dias=7')).toEqual([1])
    }finally{await c.query('ROLLBACK')}
  })
})
