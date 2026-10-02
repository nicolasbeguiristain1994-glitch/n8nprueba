'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('pg');
const {processAgent}=require('../daily.cjs');
const {processDay}=require('../ledger.cjs');
const {run:profiles}=require('../profiles.cjs');
const {SyncRunStore}=require('../monitor.cjs');
const {randomUUID}=require('node:crypto');
const enabled=process.env.CASINO_TEST_DATABASE_URL;
test('real PostgreSQL: cents, imported history, replay, locks and crash recovery', {skip:!enabled},async()=>{
 const u=new URL(enabled);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&['55432','55438'].includes(u.port));
 const cfg={host:u.hostname,port:Number(u.port),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:u.pathname.slice(1),ssl:false};
 const admin=new Client(cfg);await admin.connect();const db='daily_fixture_'+Date.now();let c,other;
 try{
  await admin.query('CREATE DATABASE "'+db+'"');c=new Client({...cfg,database:db});await c.connect();
  await c.query(`CREATE TABLE casino_players(username text,username_lower text GENERATED ALWAYS AS(lower(username)) STORED UNIQUE,agente text,platform text,total_cargas numeric(20,2),total_retiros numeric(20,2),cant_cargas int,cant_retiros int,fecha_primera date,fecha_ultima date,seg_monto text,seg_actividad text,updated_at timestamptz,labels text[] DEFAULT ARRAY['keep']);
   CREATE TABLE casino_transactions(id bigserial PRIMARY KEY,id_rec bigint,platform text,agente text,username text,tipo text,monto numeric(20,2),fecha date,fecha_hora_utc timestamptz,source_id text,source_file text,raw_detalles text,UNIQUE(platform,id_rec));
   CREATE TABLE casino_sync_runs(run_id uuid PRIMARY KEY,status text,heartbeat_at timestamptz);
   CREATE TABLE casino_sync_cursors(platform text,agente text,covered_from date,covered_through date,last_run_id uuid REFERENCES casino_sync_runs,updated_at timestamptz,PRIMARY KEY(platform,agente));
   CREATE TABLE casino_sync_agent_ranges(run_id uuid,platform text,agente text,desde date,hasta date,status text,coverage text,cursor_moved bool,fetch_started_at timestamptz,tx_fetched int,tx_normalized int,tx_inserted int,tx_updated int,tx_without_id int,tx_duplicate_ids int,tx_collapsed_without_id int,tx_invalid int,tx_excluded int,players_recomputed int,error_code text,error_message text);
   INSERT INTO casino_players(username,platform,total_cargas) VALUES('legacy','zeus',100),('ambiguous','zeus',50),('imported','zeus',500);
   INSERT INTO casino_transactions(id_rec,platform,agente,username,tipo,monto,fecha,fecha_hora_utc,source_id) VALUES
    (1,NULL,'betcoin','legacy','carga',100,'2026-08-31','2026-08-31T12:00Z',NULL),
    (2,'zeus','betcoin','ambiguous','carga',50,'2026-08-31','2026-08-31T12:00Z',NULL),
    (3,'bet30','btcuno','ambiguous','carga',75,'2026-08-31','2026-08-31T12:00Z',NULL),
    (4,'zeus','betcoin','imported','carga',500,'2026-09-01','2026-09-01T12:00Z','excel:2');`);
  const store=new SyncRunStore(c),runId=randomUUID();await c.query("INSERT INTO casino_sync_runs VALUES($1,'running',now())",[runId]);
  const raw=['legacy','ambiguous','imported'].map((username,i)=>({id:String(9007199254740993n+BigInt(i)),username,creator_username:'betcoin',valor:'100.49',fecha:'2026-09-22T08:00:00.123456Z',detalles:'Carga directa'}));
  const source={config:{timezone:'-03',endpoint:'/fixture'},baseUrl:'https://fixture.invalid',apiKey:'fixture',playerToken:'fixture',async _fetchWithRetry(url){return new Response(JSON.stringify({data:new URL(url).searchParams.get('startDate').includes('12:00')?[]:raw}),{headers:{'content-type':'application/json'}});}};
  const args={platform:'zeus',agent:'betcoin',runId,until:'2026-09-22',apply:true,assertActive(){}};
  const first=await processAgent(c,store,source,args);assert.equal(first.inserted,3);assert.equal(first.ambiguous,1);
  assert.deepEqual(await store.getCursor('zeus','betcoin'),{coveredFrom:'2026-09-22',coveredThrough:'2026-09-22'});
  let rows=(await c.query('SELECT username,total_cargas::text,labels FROM casino_players ORDER BY username')).rows;
  assert.deepEqual(rows.map(r=>[r.username,r.total_cargas]),[['ambiguous','50.00'],['imported','500.00'],['legacy','200.49']]);assert.ok(rows.every(r=>r.labels[0]==='keep'));
  assert.equal((await c.query("SELECT sum(monto)::text s FROM casino_transactions WHERE username='imported' AND source_id IS NOT NULL")).rows[0].s,'600.49');
  const second=await processAgent(c,store,source,args);assert.equal(second.inserted,0);assert.equal((await c.query('SELECT count(*)::int n FROM casino_transactions')).rows[0].n,7);
  // A profile/cursor failure rolls back both; the already committed ledger is
  // deliberately replayable and no day is falsely advertised as complete.
  await c.query('DELETE FROM casino_sync_cursors');
  const badStore=Object.create(store);badStore.saveCursor=async()=>{throw Error('SYNTHETIC_CURSOR_FAILURE');};
  await assert.rejects(processAgent(c,badStore,source,args),/SYNTHETIC_CURSOR_FAILURE/);
  assert.equal(await store.getCursor('zeus','betcoin'),null);
  assert.equal((await processAgent(c,store,source,args)).inserted,0);
  await c.query("UPDATE casino_transactions SET monto=100 WHERE id_rec=$1",[raw[0].id]);
  await assert.rejects(processAgent(c,store,source,args),/REPLAY_AMOUNT_MISMATCH/);
  await c.query("UPDATE casino_transactions SET monto=100.49 WHERE id_rec=$1",[raw[0].id]);
  const failingSource={...source,async _fetchWithRetry(){throw Error('SYNTHETIC_FETCH_FAILURE');}};
  await assert.rejects(processAgent(c,store,failingSource,args),/SYNTHETIC_FETCH_FAILURE/);
  assert.equal((await c.query('SELECT count(*)::int n FROM casino_transactions')).rows[0].n,7);
  other=new Client({...cfg,database:db});await other.connect();await other.query("SELECT pg_advisory_lock(7125,hashtext('casino_sync:daily_worker'))");
  const {normalize}=require('../normalize.cjs');const p={platform:'zeus',agent:'betcoin',day:'2026-09-22',partitionVerified:true,sourceIds:raw.map(r=>r.id),...normalize(raw,'zeus','betcoin','2026-09-22')};
  await assert.rejects(processDay(c,p,true),/WRITER_BUSY/);await other.end();other=null;
  // Transaction rollback must preserve labels and values after a failed hook.
  rows=(await c.query('SELECT * FROM casino_players ORDER BY username')).rows;
  await assert.rejects(profiles(c,raw.map(r=>r.id),true,{beforeCommit:async()=>{throw Error('ROLLBACK');}}),/ROLLBACK/);
  assert.deepEqual((await c.query('SELECT * FROM casino_players ORDER BY username')).rows,rows);
 }finally{if(other)await other.end();if(c)await c.end();await admin.query('DROP DATABASE IF EXISTS "'+db+'"');await admin.end();}
});
