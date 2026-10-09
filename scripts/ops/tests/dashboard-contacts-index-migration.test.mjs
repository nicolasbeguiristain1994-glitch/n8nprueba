import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

test('active contacts index preserves exact counts and avoids scanning wide contact rows', {skip: !process.env.OPS_TEST_DATABASE_URL}, async () => {
  const url = new URL(process.env.OPS_TEST_DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY');
  const admin = new pg.Client({connectionString:url.toString(),ssl:false});
  const database = `contacts_index_test_${process.pid}_${Date.now()}`;
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = '/' + database;
  const db = new pg.Client({connectionString:url.toString(),ssl:false});
  await db.connect();
  try {
    await db.query('CREATE TABLE contacts(id int,created_at timestamptz,deleted_at timestamptz,first_name text)');
    await db.query(`INSERT INTO contacts SELECT n,now()-n*interval '1 second',
      CASE WHEN n%10=0 THEN now() END,repeat('synthetic',100) FROM generate_series(1,100000) n`);
    const sql = fs.readFileSync(new URL('../../../db/migrations/149_dashboard_active_contacts_index.sql', import.meta.url), 'utf8');
    const verify = fs.readFileSync(new URL('../../../db/migrations/149_dashboard_active_contacts_index.verify.sql', import.meta.url), 'utf8');
    const check = async () => (await db.query(verify)).rows[0].ok;
    assert.equal(await check(), false);
    await db.query(sql); assert.equal(await check(), true);
    await db.query(sql); assert.equal(await check(), true);
    await db.query('VACUUM ANALYZE contacts');
    const countSql = 'SELECT count(*)::int AS contacts FROM contacts WHERE deleted_at IS NULL';
    assert.equal((await db.query(countSql)).rows[0].contacts,90000);
    const countPlan = JSON.stringify((await db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+countSql)).rows);
    assert.match(countPlan,/Index Only Scan/); assert.match(countPlan,/idx_contacts_active_created/);
    const recentSql = 'SELECT id FROM contacts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5';
    assert.deepEqual((await db.query(recentSql)).rows.map(r=>r.id),[1,2,3,4,5]);
    const recentPlan = JSON.stringify((await db.query('EXPLAIN (FORMAT JSON) '+recentSql)).rows);
    assert.match(recentPlan,/idx_contacts_active_created/); assert.doesNotMatch(recentPlan,/Seq Scan/);
    await db.query('DROP INDEX idx_contacts_active_created');
    await db.query('CREATE INDEX idx_contacts_active_created ON contacts(created_at DESC)');
    assert.equal(await check(), false);
  } finally {
    await db.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end();
  }
});
