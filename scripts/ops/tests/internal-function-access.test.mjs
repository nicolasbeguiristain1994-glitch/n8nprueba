import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
const migration = fs.readFileSync(new URL('../../../db/migrations/152_restrict_internal_function_access.sql', import.meta.url), 'utf8');
const signatures = [
  'get_active_warmup_lines()', 'get_line_health_data(uuid)', 'warmup_daily_reset()',
  'warmup_record_activity(uuid,uuid,text,text,text,text,integer,boolean,boolean)',
  'warmup_record_activity(uuid,uuid,text,text,text,text,integer,boolean,boolean,integer,jsonb,text,integer)',
];
test('PostgreSQL restricts internal RPCs while preserving service access, triggers and the other product', {skip: !process.env.OPS_TEST_DATABASE_URL}, async () => {
  const url = new URL(process.env.OPS_TEST_DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(url.hostname) || url.search) throw Error('LOCAL_ONLY');
  const database = `ops_security_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({connectionString: url.toString(), ssl:false}); await admin.connect();
  let client;
  try {
    await admin.query(`CREATE DATABASE "${database}"`); url.pathname = '/' + database;
    client = new pg.Client({connectionString:url.toString(), ssl:false}); await client.connect();
    for (const role of ['anon','authenticated','service_role']) {
      await client.query(`DO $r$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $r$`);
    }
    for (const signature of signatures) await client.query(`CREATE FUNCTION public.${signature} RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS 'SELECT 42'`);
    await client.query(`CREATE TABLE public.scoring_fixture(id int PRIMARY KEY, value int);
      CREATE TABLE public.audit_fixture(value int);
      INSERT INTO public.scoring_fixture VALUES(1,0);
      GRANT SELECT,UPDATE ON public.scoring_fixture TO anon;
      CREATE FUNCTION public.log_scoring_config_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $f$ BEGIN INSERT INTO public.audit_fixture VALUES(NEW.value); RETURN NEW; END $f$;
      CREATE FUNCTION public.log_segmentation_tier_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $f$ BEGIN INSERT INTO public.audit_fixture VALUES(NEW.value); RETURN NEW; END $f$;
      CREATE TRIGGER scoring_log AFTER UPDATE ON public.scoring_fixture FOR EACH ROW EXECUTE FUNCTION public.log_scoring_config_change();
      CREATE TRIGGER segmentation_log AFTER UPDATE ON public.scoring_fixture FOR EACH ROW EXECUTE FUNCTION public.log_segmentation_tier_change();
      CREATE TABLE public."Participantes"(id int);
      CREATE TABLE public.participantes_1000(id int);
      CREATE TABLE public.participantes_duende(id int);
      GRANT SELECT,INSERT ON public."Participantes",public.participantes_1000,public.participantes_duende TO anon;
      CREATE FUNCTION public.other_product_function() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 7';`);
    const snapshot = async () => (await client.query(`SELECT relname,relacl FROM pg_class WHERE relname IN ('Participantes','participantes_1000','participantes_duende') ORDER BY relname`)).rows;
    const before = await snapshot();
    assert.equal((await client.query("SELECT has_function_privilege('anon','public.warmup_daily_reset()','EXECUTE') AS ok")).rows[0].ok,true);
    await client.query(migration); await client.query(migration); // reruns are safe
    for (const signature of [...signatures,'log_scoring_config_change()','log_segmentation_tier_change()']) {
      const {rows:[row]} = await client.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated,has_function_privilege('service_role',$1,'EXECUTE') AS service`, ['public.'+signature]);
      assert.deepEqual(row,{anon:false,authenticated:false,service:true});
    }
    for (const role of ['anon','authenticated']) {
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(client.query('SELECT public.warmup_daily_reset()'), {code:'42501'});
      await client.query('RESET ROLE');
    }
    await client.query('SET ROLE service_role');
    assert.equal((await client.query('SELECT public.warmup_daily_reset() AS value')).rows[0].value,42);
    await client.query('RESET ROLE; SET ROLE anon; UPDATE public.scoring_fixture SET value=9 WHERE id=1; RESET ROLE');
    assert.deepEqual((await client.query('SELECT value FROM public.audit_fixture')).rows,[{value:9},{value:9}]);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await client.query("SELECT has_function_privilege('anon','public.other_product_function()','EXECUTE') AS ok")).rows[0].ok,true);
    // Optional modules may be absent on a fresh installation.
    for (const signature of signatures) await client.query(`DROP FUNCTION public.${signature}`);
    await client.query(migration);
  } finally {
    if (client) await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end();
  }
});
