import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

test('conversation views migration protects shared acknowledgements from the public Data API', { skip: !process.env.OPS_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.OPS_TEST_DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY');
  const admin = new pg.Client({connectionString:url.toString(),ssl:false});
  const database = `conversation_views_test_${process.pid}_${Date.now()}`;
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = '/' + database;
  const db = new pg.Client({connectionString:url.toString(),ssl:false}); await db.connect();
  try {
    await db.query(fs.readFileSync(new URL('../../../db/migrations/153_conversation_message_views.sql',import.meta.url),'utf8'));
    const relation = (await db.query("SELECT relrowsecurity,relacl FROM pg_class WHERE oid='public.conversation_message_views'::regclass")).rows[0];
    assert.equal(relation.relrowsecurity,true);
    const grants = (await db.query(`SELECT count(*)::int AS n FROM pg_class c, LATERAL aclexplode(c.relacl) acl
      LEFT JOIN pg_roles r ON r.oid=acl.grantee WHERE c.oid='public.conversation_message_views'::regclass
      AND (acl.grantee=0 OR r.rolname IN ('anon','authenticated'))`)).rows[0];
    assert.equal(grants.n,0);
    await db.query("INSERT INTO conversation_message_views(message_key) VALUES('wamid.example')");
    await db.query("INSERT INTO conversation_message_views(message_key) VALUES('wamid.example') ON CONFLICT DO NOTHING");
    assert.equal((await db.query('SELECT count(*)::int AS n FROM conversation_message_views WHERE viewed_at IS NOT NULL')).rows[0].n,1);
  } finally { await db.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end(); }
});
