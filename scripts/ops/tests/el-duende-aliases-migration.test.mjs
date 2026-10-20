import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
const read = file => fs.readFileSync(new URL('../../../db/migrations/' + file, import.meta.url), 'utf8');
test('El Duende aliases match the same operator while preserving other agents and function access', {skip:!process.env.OPS_TEST_DATABASE_URL}, async () => {
 const url=new URL(process.env.OPS_TEST_DATABASE_URL);
 if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY');
 const admin=new pg.Client({connectionString:url.toString(),ssl:false});await admin.connect();
 const name=`duende_aliases_${process.pid}_${Date.now()}`;
 await admin.query(`CREATE DATABASE "${name}"`);url.pathname='/'+name;
 const db=new pg.Client({connectionString:url.toString(),ssl:false});await db.connect();
 try {
  for(const role of ['anon','authenticated','service_role'])await db.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  const original=read('154_contact_accounts_agent_consent.sql');
  const start=original.indexOf('CREATE OR REPLACE FUNCTION public.contact_agent_key');
  await db.query(original.slice(start,original.indexOf('$$;',start)+3));
  await db.query('REVOKE ALL ON FUNCTION public.contact_agent_key(text) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.contact_agent_key(text) TO service_role');
  const others=['royal','adminroyal','btcuno','btcdos','zeus','zeusroyal','adminbtc','adminzeus','admbigwin','adminfara','amdfarabet','adminimperio','lasvegas',null,'','other'];
  const baseline=(await db.query('SELECT value,public.contact_agent_key(value) AS agent FROM unnest($1::text[]) value',[others])).rows;
  await db.query(read('160_el_duende_agent_aliases.sql'));
  assert.deepEqual((await db.query('SELECT value,public.contact_agent_key(value) AS agent FROM unnest($1::text[]) value',[others])).rows,baseline);
  const actual=(await db.query("SELECT public.contact_agent_key(value) AS agent FROM unnest(ARRAY['facuadmin1',' DuendeVerde ','ELDUENDE']) value")).rows;
  assert.deepEqual(actual,[{agent:'elduende'},{agent:'elduende'},{agent:'elduende'}]);
  const security=(await db.query("SELECT p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') AS service FROM pg_proc p WHERE p.oid='public.contact_agent_key(text)'::regprocedure")).rows[0];
  assert.deepEqual(security,{prosecdef:false,anon:false,authenticated:false,service:true});
 } finally {await db.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end()}
});
