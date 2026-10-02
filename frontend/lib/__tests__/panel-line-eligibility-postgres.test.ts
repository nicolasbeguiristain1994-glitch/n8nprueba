// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { campaignLineEligibleExpr } from '@/lib/line-eligibility'
import { effectivePermissions } from '@/lib/permissions'

it('includes effective permissions for all three independently assigned modules', () => {
  for (const resource of ['templates','automations','estadisticas'] as const) {
    expect(effectivePermissions({role:'operator',sectors:[resource]})[resource]).toEqual(['read','create','update','send'])
    expect(effectivePermissions({role:'viewer',sectors:[resource]})[resource]).toEqual(['read'])
    expect(effectivePermissions({role:'operator',sectors:[]})[resource]).toBeUndefined()
  }
})

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('line eligibility for both providers on local PostgreSQL', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false }); await db.connect()
    await db.query(`BEGIN;
      CREATE TEMP TABLE cloud_numbers(whatsapp_line_id int,status text);
      CREATE TEMP TABLE audit_lines(id int,line_type text,status text,is_connected bool,sending_enabled bool,msgs_sent_hour int,msg_per_hour int,msgs_sent_today int,msg_per_day int,allowed_types jsonb);
      INSERT INTO audit_lines SELECT n,CASE WHEN n=1 THEN 'evolution' ELSE 'cloud' END,'active',true,true,0,10,0,100,'["campaign"]' FROM generate_series(1,7)n;
      INSERT INTO cloud_numbers VALUES(2,'active'),(3,'pending'),(4,'active'),(5,'active'),(6,'active');
      UPDATE audit_lines SET sending_enabled=false WHERE id=4;
      UPDATE audit_lines SET msgs_sent_today=msg_per_day WHERE id=5;
      UPDATE audit_lines SET allowed_types='["manual"]' WHERE id=6;`)
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  it('shows Evolution and registered Cloud lines as eligible, respecting kill switch, quotas and allowed traffic', async () => {
    const rows = (await db.query(`SELECT id,${campaignLineEligibleExpr('l')} AS eligible FROM audit_lines l ORDER BY id`)).rows
    expect(rows.map(r=>r.eligible)).toEqual([true,true,false,false,false,false,false])
  })
})
