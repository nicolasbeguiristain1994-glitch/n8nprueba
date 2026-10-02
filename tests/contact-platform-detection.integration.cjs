const {describe,it,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),{Client}=require('../frontend/node_modules/pg');
const url=process.env.CONTACTS_TEST_DATABASE_URL;
describe('Ganamos and Argenbet contact discovery',{skip:!url},()=>{
 let c;const schema='platform_detection_'+process.pid;
 before(async()=>{const u=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.search,'');c=new Client({connectionString:url});await c.connect();await c.query(`CREATE SCHEMA ${schema};SET search_path=${schema},public;
 CREATE TABLE contacts(id int PRIMARY KEY,first_name text,last_name text,casino_accounts jsonb DEFAULT '[]',platforms text[] DEFAULT '{}',deleted_at timestamptz,segment text,updated_at timestamptz);
 CREATE FUNCTION preserve_explicit_casino_platforms() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;';
 CREATE TRIGGER trg_contact_platforms_imported BEFORE INSERT OR UPDATE OF first_name,last_name,casino_accounts,platforms ON contacts FOR EACH ROW EXECUTE FUNCTION preserve_explicit_casino_platforms();
 INSERT INTO contacts VALUES(1,'User123z/User456ga User789arg',NULL,'[]',ARRAY['zeus'],NULL,'medio','2026-09-01T00:00:00Z'),(2,'Deleted123ga',NULL,'[]','{}',now(),'vip',now());`);
 await c.query(fs.readFileSync('db/migrations/132_contacts_ganamos_argenbet_detection.sql','utf8'));});
 after(async()=>{if(c){await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end()}});
 for(const [name,want] of [['Alicia6484ga',['ganamos']],['User123gs',['ganamos']],['User123gg',['ganamos']],['User123a',['argenbet']],['User123ar',['argenbet']],['User123arg',['argenbet']],['(C.MUCHO)User123ga/User123ar',['argenbet','ganamos']],['Marcela Garcia',[]],['user123a@gmail.com',[]],['User123b',[]]])
 it('detects '+name,async()=>{assert.deepEqual((await c.query("SELECT contact_additional_platforms($1,NULL,'[]') p",[name])).rows[0].p,want)});
 it('honors explicit platforms over suffixes',async()=>{assert.deepEqual((await c.query(`SELECT contact_additional_platforms('User123g',NULL,'[{"username":"User123g","platform":"argenbet"}]') p`)).rows[0].p,[])});
 it('backfills missing markers without changing level, timestamps or deleted contacts',async()=>{const rows=(await c.query('SELECT * FROM contacts ORDER BY id')).rows;assert.deepEqual(rows[0].platforms,['argenbet','ganamos','zeus']);assert.equal(rows[0].segment,'medio');assert.equal(rows[0].updated_at.toISOString(),'2026-09-01T00:00:00.000Z');assert.deepEqual(rows[1].platforms,[])});
 it('retains discovery after daily account enrichment and detects future imports',async()=>{await c.query(`UPDATE contacts SET casino_accounts='[{"username":"User123z","platform":"zeus"}]' WHERE id=1`);assert.deepEqual((await c.query('SELECT platforms FROM contacts WHERE id=1')).rows[0].platforms,['argenbet','ganamos','zeus']);await c.query(`INSERT INTO contacts(id,first_name) VALUES(3,'Future123ga')`);assert.deepEqual((await c.query('SELECT platforms FROM contacts WHERE id=3')).rows[0].platforms,['ganamos'])});
 it('is idempotent',async()=>{await c.query(fs.readFileSync('db/migrations/132_contacts_ganamos_argenbet_detection.sql','utf8'));assert.deepEqual((await c.query('SELECT platforms FROM contacts WHERE id=1')).rows[0].platforms,['argenbet','ganamos','zeus'])});
});
