import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

test('latest movement index verifies the exact expression, ordering and readiness', {skip: !process.env.OPS_TEST_DATABASE_URL}, async () => {
  const url = new URL(process.env.OPS_TEST_DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY');
  const admin = new pg.Client({connectionString:url.toString(),ssl:false});
  const database = `latest_index_test_${process.pid}_${Date.now()}`;
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = '/' + database;
  const db = new pg.Client({connectionString:url.toString(),ssl:false});
  await db.connect();
  try {
    await db.query('CREATE TABLE casino_transactions(platform text,agente varchar(100),fecha date,fecha_hora_utc timestamptz)');
    const sql = fs.readFileSync(new URL('../../../db/migrations/148_dashboard_latest_movement_index.sql', import.meta.url), 'utf8');
    const verify = fs.readFileSync(new URL('../../../db/migrations/148_dashboard_latest_movement_index.verify.sql', import.meta.url), 'utf8');
    const check = async () => (await db.query(verify)).rows[0].ok;
    assert.equal(await check(), false);
    await db.query(sql); assert.equal(await check(), true);
    await db.query(sql); assert.equal(await check(), true);
    await db.query('DROP INDEX idx_casino_latest_movement');
    await db.query('CREATE INDEX idx_casino_latest_movement ON casino_transactions(platform,agente,fecha DESC NULLS LAST) WHERE platform IS NOT NULL');
    assert.equal(await check(), false);
  } finally {
    await db.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end();
  }
});
