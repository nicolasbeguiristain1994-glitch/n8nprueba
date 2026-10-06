// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
const mocks = vi.hoisted(() => ({ query:vi.fn() }))
vi.mock('@/lib/db', () => ({ query:mocks.query }))
import { templateRepository } from '../cloud-api/repositories/template.repository'

describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('Webhook template WABA isolation on PostgreSQL', () => {
  let db:Client
  beforeAll(async () => {
    const url = new URL(process.env.OPS_TEST_DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('LOCAL_ONLY')
    db = new Client({connectionString:url.toString(),ssl:false});await db.connect();await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE whatsapp_templates(id int,whatsapp_template_id text,waba_id text,status text,rejection_reason text,updated_at timestamptz);
      SET LOCAL search_path=pg_temp,public;
      INSERT INTO whatsapp_templates(id,whatsapp_template_id,waba_id,status) VALUES (1,'same-id','87654','EN_REVISION'),(2,'same-id','23456','EN_REVISION'),(3,'same-id',NULL,'EN_REVISION');`)
    mocks.query.mockImplementation(async(sql,params) => (await db.query(sql,params)).rows)
  })
  afterAll(async () => { if(db) { await db.query('ROLLBACK');await db.end() } })
  it('updates only the assigned WABA even if a Meta template ID collides', async () => {
    await templateRepository.updateTemplateStatus('same-id','APROBADA',null,{wabaId:'87654',includeLegacy:false})
    expect((await db.query('SELECT status FROM whatsapp_templates ORDER BY id')).rows.map(row=>row.status)).toEqual(['APROBADA','EN_REVISION','EN_REVISION'])
  })
  it('preserves legacy null-WABA rows without changing the independent WABA', async () => {
    await templateRepository.updateTemplateStatus('same-id','RECHAZADA','test',{wabaId:'23456',includeLegacy:true})
    expect((await db.query('SELECT status FROM whatsapp_templates ORDER BY id')).rows.map(row=>row.status)).toEqual(['APROBADA','RECHAZADA','RECHAZADA'])
  })
})
