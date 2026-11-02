// @vitest-environment node
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('agent workspace migration', () => {
  it('is repeatable, preserves existing grants and leaves historical data unassigned', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    const db = new Client({connectionString:url.toString(),ssl:false})
    const schema = `agent_migration_${process.pid}`
    await db.connect()
    try {
      await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema};
        CREATE TABLE users(id int,sectors jsonb);
        INSERT INTO users VALUES(1,'["tasks"]'),(2,'["conversations"]');
        CREATE TABLE campaigns(id uuid,created_at timestamptz);
        INSERT INTO campaigns VALUES(gen_random_uuid(),now());
        CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY);
        CREATE TABLE whatsapp_messages(phone_number text,created_at timestamptz);
        CREATE TABLE campaign_recipients(id uuid,campaign_id uuid,phone_number text,sent_at timestamptz);
        CREATE TABLE conversation_notes(phone text,created_at timestamptz);
        CREATE TABLE marketing_calendar(date date);`)
      const migration = readFileSync('../db/migrations/162_agent_workspaces.sql','utf8')
      await db.query(migration); await db.query(migration)
      expect((await db.query('SELECT sectors FROM users ORDER BY id')).rows).toEqual([
        {sectors:['tasks','calendar']},{sectors:['conversations']},
      ])
      expect((await db.query('SELECT agent_key FROM campaigns')).rows).toEqual([{agent_key:null}])
      expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='agent_conversation_state'::regclass")).rows[0].relrowsecurity).toBe(true)
    } finally {
      await db.query('ROLLBACK')
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await db.end()
    }
  })
})
