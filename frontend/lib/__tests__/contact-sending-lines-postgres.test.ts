// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
const mocks=vi.hoisted(()=>({query:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
import { contactSendingFilter, readContactSenders } from '../contact-sending-lines'
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`
const owner=id(1),other=id(2),a=id(11),b=id(12),hidden=id(13),campaign=id(20)
const phone=(n:number)=>`549110000${String(n).padStart(4,'0')}`
describe.skipIf(!process.env.CONTACTS_TEST_DATABASE_URL)('contact sender filtering matches campaign affinity (PostgreSQL)',()=>{
  let db:Pool
  const schema=`contact_sender_${process.pid}`
  beforeAll(async()=>{
    const url=new URL(process.env.CONTACTS_TEST_DATABASE_URL!)
    if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
    db=new Pool({connectionString:url.toString(),options:`-c search_path=${schema},public`})
    await db.query(`CREATE SCHEMA ${schema};
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,owner_user_id uuid,line_key text,display_name text,phone_number text);
      CREATE TABLE campaigns(id uuid PRIMARY KEY,owned_by uuid);
      CREATE TABLE campaign_recipients(campaign_id uuid,phone_number text,line_id uuid,status text,sent_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE cloud_conversations(id uuid,contact_phone text);
      CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid);
      CREATE TABLE cloud_messages(conversation_id uuid,phone_number_id text,direction text,status text,sent_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE phone_line_assignments(phone text,line_id uuid,updated_at timestamptz);
      CREATE TABLE campaign_line_assignments(owner_key uuid,phone text,line_id uuid,PRIMARY KEY(owner_key,phone));
      CREATE TABLE contacts(id uuid PRIMARY KEY,phone_number text,panel text DEFAULT 'royal',deleted_at timestamptz);
      CREATE FUNCTION get_accessible_line_ids(actor uuid) RETURNS SETOF uuid LANGUAGE sql AS 'SELECT id FROM whatsapp_lines WHERE owner_user_id=actor';`)
    mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  })
  beforeEach(async()=>{
    await db.query(`TRUNCATE whatsapp_lines,campaigns,campaign_recipients,cloud_conversations,cloud_numbers,cloud_messages,phone_line_assignments,campaign_line_assignments,contacts`)
    await db.query(`INSERT INTO whatsapp_lines VALUES($1,$4,'lexora','Lexora','+5491100000011'),($2,$4,'lexora2','Lexora 2','+5491100000012'),($3,$5,'private','Private','+5491100000013')`,[a,b,hidden,owner,other])
    await db.query('INSERT INTO campaigns VALUES($1,$2)',[campaign,owner])
    for(let n=1;n<=5;n++)await db.query('INSERT INTO contacts(id,phone_number) VALUES($1,$2)',[id(100+n),'+'+phone(n)])
    await db.query(`INSERT INTO campaign_line_assignments VALUES($1,$3,$4),($1,$5,$6),($2,$7,$4)`,[owner,other,phone(1),a,phone(2),b,phone(3)])
  })
  afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}})
  const filter=async(line:string,mode='assigned')=>{
    const f=contactSendingFilter(new URLSearchParams({sending_line:line,sending_mode:mode}),{sql:'contacts.deleted_at IS NULL AND contacts.panel=$1',params:['royal']},owner)
    return (await db.query(`SELECT id FROM contacts WHERE ${f.sql} ORDER BY id`,f.params)).rows.map(row=>row.id)
  }
  it('keeps count, selection and duplicate phone accounts scoped to the selected sender',async()=>{
    await db.query('INSERT INTO contacts(id,phone_number) VALUES($1,$2)',[id(106),'+54 (911) 0000-0001'])
    await db.query("INSERT INTO contacts(id,phone_number,panel) VALUES($1,$2,'other')",[id(107),'+'+phone(1)])
    expect(await filter(a)).toEqual([id(101),id(106)])
    expect(await filter(a,'other')).toEqual([id(102)])
    expect(await filter('unassigned')).toEqual([id(103),id(104),id(105)])
    expect(await filter(hidden)).toEqual([])
    expect(await filter(hidden,'other')).toEqual([])
  })
  it('uses existing assignment before newer history; recovers successful campaign, inbox and legacy history',async()=>{
    await db.query(`INSERT INTO campaign_recipients VALUES($1,$2,$3,'sent','2026-11-01',now()),($1,$4,$3,'sent','2026-10-01',now()),($1,$4,$5,'failed','2026-11-02',now())`,[campaign,phone(1),b,phone(3),a])
    await db.query('INSERT INTO cloud_conversations VALUES($1,$2)',[id(30),phone(4)])
    await db.query("INSERT INTO cloud_numbers VALUES('p1',$1)",[a])
    await db.query("INSERT INTO cloud_messages VALUES($1,'p1','outbound','delivered',now(),now())",[id(30)])
    await db.query('INSERT INTO phone_line_assignments VALUES($1,$2,now())',[phone(5),b])
    expect(await filter(a)).toEqual([id(101),id(104)])
    expect(await filter(b)).toEqual([id(102),id(103),id(105)])
    expect(await filter('unassigned')).toEqual([])
    expect((await db.query('SELECT COUNT(*)::int n FROM campaign_line_assignments')).rows[0].n).toBe(3)
  })
  it('never labels a hidden assignment as new or exposes its sender details',async()=>{
    await db.query('INSERT INTO campaign_line_assignments VALUES($1,$2,$3)',[owner,phone(3),hidden])
    const rows=(await db.query('SELECT id,phone_number FROM contacts ORDER BY id')).rows
    const senders=await readContactSenders(rows,owner)
    expect(senders.get(id(101))?.sending_line?.name).toBe('Lexora')
    expect(senders.get(id(103))).toEqual({sending_line:null,sending_line_hidden:true})
    expect(senders.get(id(104))).toEqual({sending_line:null,sending_line_hidden:false})
    expect(await filter('unassigned')).not.toContain(id(103))
    expect(await filter(a,'other')).toEqual([id(102),id(103)])
  })
  it('recovers null deleted assignments and rejects malformed filters instead of expanding the audience',async()=>{
    await db.query('INSERT INTO campaign_line_assignments VALUES($1,$2,NULL)',[owner,phone(4)])
    await db.query('INSERT INTO phone_line_assignments VALUES($1,$2,now())',[phone(4),a])
    expect(await filter(a)).toEqual([id(101),id(104)])
    await expect(filter("' OR true --")).rejects.toThrow('inválida')
    await expect(filter('', 'other')).rejects.toThrow('Elegí')
  })
})
