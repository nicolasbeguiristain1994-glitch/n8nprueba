// @vitest-environment node
import {afterAll,beforeAll,describe,it,expect} from 'vitest'
import {Client} from 'pg'
import {readFileSync} from 'node:fs'
import {CAMPAIGN_STATS_SQL} from '../campaign-stats'

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('Campaign SQL on local PostgreSQL',()=>{
 let db:Client
 beforeAll(async()=>{
  const url=new URL(process.env.DATABASE_URL!)
  if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect();await db.query('BEGIN')
  await db.query(`CREATE TEMP TABLE campaigns(id int,status text,scheduled_at timestamptz);
   CREATE TEMP TABLE campaign_recipients(campaign_id int,phone_number text,status text);
   CREATE TEMP TABLE whatsapp_messages(id int,campaign_id int,phone_number text,status text,direction text,created_at timestamptz);
   INSERT INTO campaigns VALUES (1,'paused',NULL),(2,'draft',NULL);
   INSERT INTO campaign_recipients VALUES (1,'+1','sent'),(1,'+2','failed'),(1,'+3','skipped'),(1,'+4','sent'),(1,'+5','sent'),(1,'+6','failed'),(1,'+7','sent'),(1,'+8','pending');
   INSERT INTO whatsapp_messages VALUES
    (1,1,'1','sent','outbound',now()),(2,1,'2','failed','outbound',now()),
    (3,1,'3','failed','outbound',now()),(4,1,'4','failed','outbound',now()),
    (5,1,'5','delivered','outbound',now()),(6,1,'6','read','outbound',now()),
    (7,1,'7','failed','outbound',now()-interval '1 minute'),(8,1,'7','sent','outbound',now()),
    (11,1,'8','failed','outbound',now()),(9,2,'1','read','outbound',now()),(10,1,'1','read','inbound',now());`)
 })
 afterAll(async()=>{if(db){await db.query('ROLLBACK');await db.end()}})
 it('counts distinct recipient outcomes, ignores older attempts and unrelated messages',async()=>{
  const rows=(await db.query(`SELECT c.id, stats.* FROM campaigns c LEFT JOIN LATERAL (${CAMPAIGN_STATS_SQL}) stats ON true ORDER BY c.id`)).rows
  expect(rows).toEqual([{id:1,sent:4,delivered:2,read:1,failed:2,skipped:1},{id:2,sent:0,delivered:0,read:0,failed:0,skipped:0}])
 })
 it('migration preserves legacy templates and supports same name across WABA/language',async()=>{
  await db.query(`SAVEPOINT template_migration;
   CREATE TEMP TABLE whatsapp_templates(id int,name text,language text,CONSTRAINT whatsapp_templates_name_key UNIQUE(name));
   INSERT INTO whatsapp_templates VALUES(1,'hello','es');`)
  try{
   const sql=readFileSync(new URL('../../../db/migrations/131_campaign_template_scope.sql',import.meta.url),'utf8')
   await db.query(sql);await db.query(sql)
   await db.query(`INSERT INTO whatsapp_templates(id,name,language,waba_id) VALUES(2,'hello','es','100'),(3,'hello','en','100'),(4,'hello','es','200')`)
   expect((await db.query('SELECT * FROM whatsapp_templates WHERE id=1')).rows[0]).toEqual({id:1,name:'hello',language:'es',waba_id:null})
   await db.query('SAVEPOINT duplicate_test')
   await expect(db.query(`INSERT INTO whatsapp_templates VALUES(5,'hello','es','100')`)).rejects.toMatchObject({code:'23505'})
   await db.query('ROLLBACK TO SAVEPOINT duplicate_test')
  }finally{await db.query('ROLLBACK TO SAVEPOINT template_migration')}
 })
})
