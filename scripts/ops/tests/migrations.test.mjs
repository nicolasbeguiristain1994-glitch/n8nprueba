import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { sha256,splitSql,loadCatalog,fingerprint,status,adoptBaseline,applyMigrations,reconcile,withMigrationLock } from '../migration-engine.mjs';
const commit='a'.repeat(40);
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-test-'));fs.mkdirSync(path.join(root,'db/migrations'),{recursive:true});fs.mkdirSync(path.join(root,'db/schema'));fs.writeFileSync(path.join(root,'db/schema/init.sql'),'CREATE TABLE contacts(id integer);');const baseline={through:1,deploymentId:'test',schemaDigest:null,files:{'db/schema/init.sql':sha256(fs.readFileSync(path.join(root,'db/schema/init.sql')))}};fs.writeFileSync(path.join(root,'db/migrations/baseline.json'),JSON.stringify(baseline));return {root,baseline,write:(name,sql)=>fs.writeFileSync(path.join(root,'db/migrations',name),sql),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('SQL splitter preserves bodies, comments, quoted semicolons and escaped strings',()=>{
 const sql="-- ;\nDO $body$ BEGIN PERFORM ';'; END $body$; SELECT 'a;''b'; SELECT E'a\\\';b'; /* outer /* ; */ ; */ SELECT 4;";
 assert.equal(splitSql(sql).length,4);assert.throws(()=>splitSql("SELECT 'unterminated"));
});
test('catalog detects missing/changed history, unsafe transaction modes and duplicate new numbers',()=>{
 const f=fixture();try{
  assert.equal(loadCatalog(f.root).migrations.length,1);
  f.write('002_index.sql','CREATE INDEX CONCURRENTLY i ON contacts(id);');assert.throws(()=>loadCatalog(f.root),/nontransactional/);
  f.write('002_index.sql','-- migrate: nontransactional\nCREATE INDEX CONCURRENTLY i ON contacts(id);');assert.throws(()=>loadCatalog(f.root),/postcondition/);
  f.write('002_index.verify.sql',"SELECT true AS ok;");assert.equal(loadCatalog(f.root).migrations[0].mode,'nontransactional');
  f.write('002_duplicate.sql','SELECT 1');assert.throws(()=>loadCatalog(f.root),/Duplicate/);fs.unlinkSync(path.join(f.root,'db/migrations/002_duplicate.sql'));
  fs.writeFileSync(path.join(f.root,'db/schema/init.sql'),'SELECT 1');assert.throws(()=>loadCatalog(f.root),/changed/);
  fs.unlinkSync(path.join(f.root,'db/schema/init.sql'));assert.throws(()=>loadCatalog(f.root));
 }finally{f.cleanup();}
});
test('real PostgreSQL: baseline, atomic migrations, locks and nontransactional recovery',{skip:!process.env.OPS_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.OPS_TEST_DATABASE_URL);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY');
 const database=`ops_migration_test_${process.pid}_${Date.now()}`;const admin=new pg.Client({connectionString:url.toString(),ssl:false});await admin.connect();
 await admin.query(`CREATE DATABASE "${database}"`);url.pathname='/'+database;
 const client=new pg.Client({connectionString:url.toString(),ssl:false});const other=new pg.Client({connectionString:url.toString(),ssl:false});await client.connect();await other.connect();
 const f=fixture();
 try{
  await client.query('CREATE TABLE contacts(id integer)');
  await t.test('status is read only; adopting mismatched schema is rejected',async()=>{
   assert.equal((await status(client,loadCatalog(f.root))).managed,false);
   assert.equal((await client.query("SELECT to_regnamespace('app_migrations') AS ns")).rows[0].ns,null);
   await assert.rejects(adoptBaseline(client,loadCatalog(f.root),commit),/fingerprint/);
   f.baseline.schemaDigest=(await fingerprint(client)).digest;fs.writeFileSync(path.join(f.root,'db/migrations/baseline.json'),JSON.stringify(f.baseline));
   const r=await adoptBaseline(client,loadCatalog(f.root),commit);assert.equal(r.recorded,1);assert.equal((await status(client,loadCatalog(f.root))).managed,true);
   assert.equal((await client.query('SELECT status FROM app_migrations.ledger')).rows[0].status,'baseline');
  });
  await t.test('concurrent migration process cannot acquire lock',async()=>{await withMigrationLock(client,async()=>{await assert.rejects(withMigrationLock(other,async()=>{}),/owns the lock/);});});
  await t.test('DDL, data and tracking roll back together',async()=>{
   f.write('002_atomic.sql','CREATE TABLE atomic_test(id integer); INSERT INTO missing_table VALUES(1);');
   await assert.rejects(applyMigrations(client,loadCatalog(f.root),commit));
   assert.equal((await client.query("SELECT to_regclass('public.atomic_test') AS relation")).rows[0].relation,null);
   assert.equal((await status(client,loadCatalog(f.root))).pending.length,1);
   f.write('002_atomic.sql','CREATE TABLE atomic_test(id integer); INSERT INTO atomic_test VALUES(1);');
   assert.equal((await applyMigrations(client,loadCatalog(f.root),commit)).applied.length,1);assert.equal((await applyMigrations(client,loadCatalog(f.root),commit)).applied.length,0);
   f.write('002_atomic.sql','SELECT 1');await assert.rejects(status(client,loadCatalog(f.root)),/checksum/);
   f.write('002_atomic.sql','CREATE TABLE atomic_test(id integer); INSERT INTO atomic_test VALUES(1);');
  });
  await t.test('concurrent indexes execute separately outside transaction and verify result',async()=>{
   f.write('003_index.sql','-- migrate: nontransactional\nCREATE INDEX CONCURRENTLY audit_contacts ON contacts(id); CREATE INDEX CONCURRENTLY audit_atomic ON atomic_test(id);');
   f.write('003_index.verify.sql',"SELECT count(*)=2 AND bool_and(indisvalid AND indisready) AS ok FROM pg_index WHERE indexrelid IN ('audit_contacts'::regclass,'audit_atomic'::regclass);");
   assert.equal((await applyMigrations(client,loadCatalog(f.root),commit)).applied.length,1);
   assert.equal((await client.query("SELECT count(*)::int n FROM app_migrations.steps WHERE status='applied'")).rows[0].n,2);
  });
  await t.test('partial special migration cannot blindly replay; reconciliation checks postcondition',async()=>{
   f.write('004_partial.sql','-- migrate: nontransactional\nCREATE TABLE partial_test(id integer); INSERT INTO not_ready VALUES(1);');
   f.write('004_partial.verify.sql',"SELECT EXISTS(SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='not_ready') AS ok;");
   await assert.rejects(applyMigrations(client,loadCatalog(f.root),commit));await assert.rejects(applyMigrations(client,loadCatalog(f.root),commit),/reconciliation/);
   await assert.rejects(reconcile(client,loadCatalog(f.root),commit,'db/migrations/004_partial.sql'),/Postcondition/);
   await client.query('CREATE TABLE not_ready(id integer); INSERT INTO not_ready VALUES(1)');
   assert.equal((await reconcile(client,loadCatalog(f.root),commit,'db/migrations/004_partial.sql')).reconciled,'db/migrations/004_partial.sql');
  });
  await t.test('manual steps block deployment until external work is verified and recorded',async()=>{
   f.write('005_manual.sql','-- migrate: manual\nCREATE TABLE manual_step(id integer);');f.write('005_manual.verify.sql',"SELECT to_regclass('public.manual_step') IS NOT NULL AS ok;");
   await assert.rejects(applyMigrations(client,loadCatalog(f.root),commit),/Manual migration/);await assert.rejects(reconcile(client,loadCatalog(f.root),commit,'db/migrations/005_manual.sql',true),/Postcondition/);
   await client.query('CREATE TABLE manual_step(id integer)');await reconcile(client,loadCatalog(f.root),commit,'db/migrations/005_manual.sql',true);assert.deepEqual((await status(client,loadCatalog(f.root))).pending,[]);
  });
 }finally{f.cleanup();await client.end();await other.end();await admin.query(`DROP DATABASE "${database}"`);await admin.end();}
});
