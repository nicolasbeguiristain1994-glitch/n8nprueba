import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

const migration=fs.readFileSync(new URL('../../../db/migrations/156_unify_contact_line_variants.sql',import.meta.url),'utf8');
test('unifies contact line variants without merging accounts, destinations or send history', {skip:!process.env.OPS_TEST_DATABASE_URL}, async()=>{
 const url=new URL(process.env.OPS_TEST_DATABASE_URL);
 if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY');
 const admin=new pg.Client({connectionString:url.toString(),ssl:false});await admin.connect();
 const name=`unify_lines_test_${process.pid}_${Date.now()}`;await admin.query(`CREATE DATABASE "${name}"`);url.pathname='/'+name;
 const db=new pg.Client({connectionString:url.toString(),ssl:false});await db.connect();
 try {
  for(const role of ['anon','authenticated'])await db.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  for(const file of ['151_agent_contact_lines.sql','155_agent_line_links.sql'])await db.query(fs.readFileSync(new URL('../../../db/migrations/'+file,import.meta.url),'utf8'));
  await db.query(`CREATE TABLE contacts(id int PRIMARY KEY,panel text,phone_number text,first_name text,linea smallint,linea_sub char(1),deleted_at timestamptz);
    CREATE TABLE campaign_recipients(id int,status text); INSERT INTO campaign_recipients VALUES(1,'skipped'),(2,'pending');
    CREATE TABLE blacklist(id int,agent_code text); INSERT INTO blacklist VALUES(1,'royal');
    CREATE TABLE whatsapp_lines(id int,display_name text); INSERT INTO whatsapp_lines VALUES(1,'Sender A');
    INSERT INTO contacts VALUES(1,'royal','+5491100000001','account1',4,'a',NULL),(2,'bigwin','+5491100000001','account2',4,'b',NULL),(3,'ofizeus','+5491100000002','deleted',1,'c',NOW()),(4,'royal','+5491100000003','no line',NULL,NULL,NULL);
    INSERT INTO agent_contact_lines(agent_code,linea,variant,label,phone,link_url,is_active) VALUES
      ('royal',4,'','Royal 4','+5491100000004','https://example.com/four',false),
      ('royal',4,'a','Obsolete','+5491100000099',NULL,true),
      ('bigwin',4,'a','Bigwin 4',NULL,'https://example.com/bigwin',true),
      ('bigwin',4,'b','Bigwin 4',NULL,'https://example.com/bigwin',true);
    UPDATE crm_agents SET delivery_mode='link' WHERE code='royal'`);
  const before=(await db.query("SELECT id,panel,phone_number,first_name,linea,deleted_at FROM contacts ORDER BY id")).rows;
  const base=(await db.query("SELECT * FROM agent_contact_lines WHERE variant='' ORDER BY agent_code,linea")).rows;
  const untouched=await db.query("SELECT jsonb_build_object('recipients',(SELECT jsonb_agg(r) FROM campaign_recipients r),'blacklist',(SELECT jsonb_agg(b) FROM blacklist b),'senders',(SELECT jsonb_agg(l) FROM whatsapp_lines l)) value");
  await db.query('BEGIN');await db.query(migration);await db.query('COMMIT');
  assert.deepEqual((await db.query('SELECT id,panel,phone_number,first_name,linea,deleted_at FROM contacts ORDER BY id')).rows,before);
  assert.equal((await db.query('SELECT count(*)::int n FROM contacts WHERE linea_sub IS NOT NULL')).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM agent_contact_lines WHERE variant<>''")).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT * FROM agent_contact_lines WHERE id=ANY($1::uuid[]) ORDER BY agent_code,linea',[base.map(x=>x.id)])).rows,base);
  assert.equal((await db.query("SELECT count(*)::int n FROM agent_contact_lines WHERE agent_code='bigwin' AND linea=4 AND link_url='https://example.com/bigwin'")).rows[0].n,1);
  assert.equal((await db.query("SELECT delivery_mode FROM crm_agents WHERE code='royal'")).rows[0].delivery_mode,'link');
  assert.deepEqual((await db.query("SELECT jsonb_build_object('recipients',(SELECT jsonb_agg(r) FROM campaign_recipients r),'blacklist',(SELECT jsonb_agg(b) FROM blacklist b),'senders',(SELECT jsonb_agg(l) FROM whatsapp_lines l)) value")).rows,untouched.rows);
  await db.query("INSERT INTO contacts(id,linea,linea_sub) VALUES(5,8,'b'); UPDATE contacts SET linea=9,linea_sub='c' WHERE id=1");
  assert.deepEqual((await db.query('SELECT id,linea,linea_sub FROM contacts WHERE id IN (1,5) ORDER BY id')).rows,[{id:1,linea:9,linea_sub:null},{id:5,linea:8,linea_sub:null}]);
  await assert.rejects(db.query("INSERT INTO agent_contact_lines(agent_code,linea,variant,label,phone) VALUES('royal',4,'c','Old','+5491100000001')"),{code:'23514'});
  assert.equal((await db.query("SELECT has_function_privilege('anon','public.normalize_contact_base_line()','EXECUTE') allowed")).rows[0].allowed,false);
  const tableSecurity=(await db.query("SELECT relrowsecurity,has_table_privilege('anon',oid,'SELECT') public_read FROM pg_class WHERE oid='public.agent_contact_lines'::regclass")).rows[0];
  assert.deepEqual(tableSecurity,{relrowsecurity:true,public_read:false});
 } finally {await db.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end()}
});

test('conflicting variant-only destinations abort the entire migration', {skip:!process.env.OPS_TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.OPS_TEST_DATABASE_URL);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY');
 const admin=new pg.Client({connectionString:url.toString(),ssl:false});await admin.connect();const name=`unify_conflict_test_${process.pid}_${Date.now()}`;await admin.query(`CREATE DATABASE "${name}"`);url.pathname='/'+name;
 const db=new pg.Client({connectionString:url.toString(),ssl:false});await db.connect();
 try {
  await db.query(`CREATE TABLE agent_contact_lines(id int,agent_code text,linea int,variant text,label text,phone text,link_url text,is_active bool);
    INSERT INTO agent_contact_lines VALUES(1,'royal',8,'a','Eight','+5491100000001',NULL,true),(2,'royal',8,'b','Eight','+5491100000002',NULL,true)`);
  await db.query('BEGIN');await assert.rejects(db.query(migration),/Conflicting variant-only destinations/);await db.query('ROLLBACK');
  assert.equal((await db.query("SELECT count(*)::int n FROM agent_contact_lines WHERE variant IN ('a','b')")).rows[0].n,2);
 } finally {await db.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end()}
});
