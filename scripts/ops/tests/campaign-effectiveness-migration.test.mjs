import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { splitSql } from '../migration-engine.mjs';

test('campaign attribution indexes verify both complete definitions', {skip: !process.env.OPS_TEST_DATABASE_URL}, async () => {
  const url = new URL(process.env.OPS_TEST_DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY');
  const admin = new pg.Client({connectionString:url.toString(),ssl:false});
  const database = `campaign_indexes_test_${process.pid}_${Date.now()}`;
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = '/' + database;
  const db = new pg.Client({connectionString:url.toString(),ssl:false});
  await db.connect();
  try {
    await db.query('CREATE TABLE casino_transactions(platform text,username varchar(100),tipo varchar(10),monto numeric(20,2),fecha date,fecha_hora_utc timestamptz)');
    const sql = fs.readFileSync(new URL('../../../db/migrations/142_campaign_effectiveness.sql', import.meta.url), 'utf8');
    const verify = fs.readFileSync(new URL('../../../db/migrations/142_campaign_effectiveness.verify.sql', import.meta.url), 'utf8');
    const check = async () => (await db.query(verify)).rows[0].ok;
    assert.equal(await check(), false);
    const steps = splitSql(sql);
    await db.query(steps[0]); assert.equal(await check(), false);
    await db.query(steps[1]); assert.equal(await check(), true);
    for (const step of steps) await db.query(step);
    assert.equal(await check(), true);
    await db.query('DROP INDEX idx_casino_campaign_deposits_date');
    await db.query("CREATE INDEX idx_casino_campaign_deposits_date ON casino_transactions(platform,lower(username),fecha) WHERE tipo='retiro' AND monto>0 AND fecha_hora_utc IS NULL");
    assert.equal(await check(), false);
  } finally {
    await db.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end();
  }
});
