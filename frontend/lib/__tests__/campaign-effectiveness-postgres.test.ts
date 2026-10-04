// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
import { CAMPAIGN_EFFECTIVENESS_SQL, type CampaignEffectiveness } from '../campaign-effectiveness'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL && process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('campaign effectiveness on PostgreSQL', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL((process.env.OPS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL)!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false })
    await db.connect()
    await db.query(`BEGIN;
      CREATE TEMP TABLE campaign_recipients(id uuid,campaign_id uuid,contact_id uuid,phone_number text,status text,sent_at timestamptz);
      CREATE TEMP TABLE whatsapp_messages(id uuid,campaign_id uuid,phone_number text,status text,direction text,created_at timestamptz,sent_at timestamptz);
      CREATE TEMP TABLE casino_contact_account_links(contact_id uuid,platform text,username_lower text);
      CREATE TEMP VIEW contacts AS SELECT contact_id AS id,NULL::text AS first_name,NULL::text AS last_name,NULL::timestamptz AS deleted_at,
        jsonb_agg(jsonb_build_object('username',username_lower,'platform',platform)) AS casino_accounts FROM casino_contact_account_links GROUP BY contact_id;
      CREATE TEMP VIEW casino_players AS SELECT DISTINCT md5(platform || ':' || username_lower)::uuid AS id,
        platform,username_lower,'admin'::text AS agente FROM casino_contact_account_links;
      CREATE TEMP TABLE casino_transactions(id bigint,platform text,username text,tipo text,monto numeric,fecha date,fecha_hora_utc timestamptz,raw_detalles text);
      ALTER TABLE casino_transactions ADD source_id text, ADD agente text;
      CREATE TEMP TABLE casino_financial_source_records(transaction_id bigint,platform text,kind text,monto numeric);`)
  })
  beforeEach(async () => {
    await db.query(`SAVEPOINT test_case;
      INSERT INTO campaign_recipients VALUES('${id(10)}','${id(1)}','${id(100)}','+549 11','sent','2026-09-30T22:00:00Z');
      INSERT INTO whatsapp_messages VALUES('${id(20)}','${id(1)}','54911','read','outbound','2026-09-30T18:00:00Z','2026-09-30T22:00:00Z');
      INSERT INTO casino_contact_account_links VALUES('${id(100)}','bet30','player');`)
  })
  afterEach(async () => { await db.query('ROLLBACK TO SAVEPOINT test_case') })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  const stats = async (campaign = 1, details = true) =>
    (await db.query<CampaignEffectiveness>(CAMPAIGN_EFFECTIVENESS_SQL, [[id(campaign)], details])).rows[0]
  const deposit = async (n: number, at: string | null, amount = '100.10', platform = 'bet30', username = 'PLAYER') => {
    await db.query(`INSERT INTO casino_transactions(id,platform,username,tipo,monto,fecha,fecha_hora_utc,raw_detalles) VALUES($1,$2,$3,'carga',$4,'2026-10-01',$5,NULL)`, [n, platform, username, amount, at])
  }
  it('uses actual sends across midnight; excludes before/equal and after 24 h, includes exactly 24 h', async () => {
    await deposit(1, '2026-09-30T21:59:59Z')
    await deposit(2, '2026-09-30T22:00:00Z')
    await deposit(3, '2026-10-01T01:00:00Z')
    await deposit(4, '2026-10-01T22:00:00Z', '200.20')
    await deposit(5, '2026-10-01T22:00:00.001Z')
    await db.query(`INSERT INTO casino_financial_source_records VALUES(3,'bet30','importe_original',100.123456789)`)
    expect(await stats()).toMatchObject({ efectivos: 1, tasa_efectividad: '100.0', cargas_24h: 2,
      monto_cargado_24h: '300.323456789', monto_apostado_24h: null,
      efectivos_detalle: [expect.objectContaining({ contact_id: id(100), cargas: 2, monto_cargado: '300.323456789',
        cuentas_carga: [{ usuario: 'player', plataforma: 'bet30' }] })] })
  })
  it('excludes bonuses, withdrawals, zero amounts and the same username on another platform', async () => {
    await deposit(1, '2026-10-01T01:00:00Z')
    await deposit(2, '2026-10-01T01:00:00Z')
    await deposit(3, '2026-10-01T01:00:00Z', '0')
    await deposit(4, '2026-10-01T01:00:00Z', '9000', 'zeus')
    await db.query(`UPDATE casino_transactions SET raw_detalles=' Bono ' WHERE id=1;
      UPDATE casino_transactions SET tipo='retiro' WHERE id=2`)
    expect(await stats()).toMatchObject({ efectivos: 0, monto_cargado_24h: '0', cargas_24h: 0 })
  })
  it('ignores duplicate links and counts several accounts once per recipient', async () => {
    await db.query(`INSERT INTO casino_contact_account_links VALUES
      ('${id(100)}','bet30','player'),('${id(100)}','zeus','second'),
      ('${id(100)}','zeus','player'),('${id(100)}','ganamos','outside'),('${id(100)}','argenbet','dateonly')`)
    await deposit(1, '2026-10-01T01:00:00Z')
    await deposit(2, '2026-10-01T01:00:00Z', '200.20', 'zeus', 'second')
    await deposit(3, '2026-10-01T02:00:00Z', '50', 'zeus', 'player')
    await deposit(4, '2026-10-01T22:00:01Z', '900', 'ganamos', 'outside')
    await deposit(5, null, '800', 'argenbet', 'dateonly')
    const result = await stats()
    expect(result).toMatchObject({ efectivos: 1, cargas_24h: 3, monto_cargado_24h: '350.30' })
    expect(result.efectivos_detalle[0].cuentas_carga).toEqual([
      { usuario: 'player', plataforma: 'bet30' },
      { usuario: 'player', plataforma: 'zeus' },
      { usuario: 'second', plataforma: 'zeus' },
    ])
  })
  it('does not double-sum a transaction linked to two recipients', async () => {
    await db.query(`INSERT INTO campaign_recipients VALUES('${id(11)}','${id(1)}','${id(101)}','54922','sent','2026-09-30T23:00:00Z');
      INSERT INTO casino_contact_account_links VALUES('${id(101)}','bet30','player')`)
    await deposit(1, '2026-10-01T01:00:00Z')
    expect(await stats()).toMatchObject({ efectivos: 2, cargas_24h: 1, monto_cargado_24h: '100.10' })
  })
  it('reports date-only loads without treating them as conversions', async () => {
    await deposit(1, null)
    await deposit(2, null)
    await db.query(`UPDATE casino_transactions SET fecha='2026-10-03' WHERE id=2`)
    expect(await stats()).toMatchObject({ efectivos: 0, cargas_sin_hora: 1, monto_cargado_24h: '0' })
  })
  it('uses the latest outcome, ignoring failed, skipped and queued recipients', async () => {
    await deposit(1, '2026-10-01T01:00:00Z')
    await db.query(`INSERT INTO whatsapp_messages VALUES('${id(21)}','${id(1)}','54911','failed','outbound','2026-10-01T00:00:00Z',NULL)`)
    expect(await stats()).toMatchObject({ efectivos: 0, tasa_efectividad: null })
    await db.query(`UPDATE campaign_recipients SET status='pending'; UPDATE whatsapp_messages SET status='queued' WHERE id='${id(21)}'`)
    expect(await stats()).toMatchObject({ efectivos: 0 })
    await db.query(`UPDATE campaign_recipients SET status='skipped'; UPDATE whatsapp_messages SET status='sent' WHERE id='${id(21)}'`)
    expect(await stats()).toMatchObject({ efectivos: 0 })
  })
  it('does not attribute to a failed attempt before a successful retry', async () => {
    await db.query(`UPDATE whatsapp_messages SET status='failed',sent_at=NULL;
      INSERT INTO whatsapp_messages VALUES('${id(21)}','${id(1)}','54911','sent','outbound','2026-10-01T06:00:00Z','2026-10-01T06:00:00Z')`)
    await deposit(1, '2026-10-01T01:00:00Z')
    await deposit(2, '2026-10-01T07:00:00Z')
    expect(await stats()).toMatchObject({ efectivos: 1, cargas_24h: 1, monto_cargado_24h: '100.10' })
  })
  it('reports unlinked contacts, absent send times, open windows and empty campaigns', async () => {
    await db.query(`INSERT INTO campaign_recipients VALUES
      ('${id(11)}','${id(1)}','${id(101)}','54922','sent',NOW()),
      ('${id(12)}','${id(1)}','${id(100)}','54933','sent',NULL)`)
    expect(await stats()).toMatchObject({ efectivos: 0, sin_cuenta: 1, sin_hora_envio: 1, ventanas_abiertas: 1 })
    expect(await stats(2)).toMatchObject({ efectivos: 0, tasa_efectividad: null, monto_cargado_24h: '0', efectivos_detalle: [] })
  })
  it('measures each recipient from their own send time and divides by all successful sends', async () => {
    await db.query(`INSERT INTO campaign_recipients VALUES('${id(11)}','${id(1)}','${id(101)}','54922','sent','2026-10-01T03:00:00Z');
      INSERT INTO casino_contact_account_links VALUES('${id(101)}','bet30','second')`)
    await deposit(1, '2026-10-01T01:00:00Z')
    await deposit(2, '2026-10-01T01:00:00Z', '400', 'bet30', 'second')
    expect(await stats()).toMatchObject({ efectivos: 1, tasa_efectividad: '50.0', cargas_24h: 1, monto_cargado_24h: '100.10' })
  })
  it('falls back to recipient send time, without using queued message creation as a send', async () => {
    await db.query(`UPDATE whatsapp_messages SET status='queued',sent_at=NULL`)
    await deposit(1, '2026-09-30T20:00:00Z')
    expect(await stats()).toMatchObject({ efectivos: 0, sin_hora_envio: 0 })
    await db.query('UPDATE campaign_recipients SET sent_at=NULL')
    expect(await stats()).toMatchObject({ efectivos: 0, sin_hora_envio: 1 })
  })
  it('evaluates each campaign window independently and omits detail for the list', async () => {
    await db.query(`INSERT INTO campaign_recipients VALUES('${id(11)}','${id(2)}','${id(100)}','54911','sent','2026-10-01T00:00:00Z')`)
    await deposit(1, '2026-10-01T01:00:00Z')
    expect(await stats()).toMatchObject({ efectivos: 1 })
    expect(await stats(2, false)).toMatchObject({ efectivos: 1, efectivos_detalle: [] })
  })
  it('uses bounded deposit indexes with a large unrelated and out-of-window history', async () => {
    await db.query(`CREATE INDEX campaign_test_imports ON casino_transactions(lower(username),platform) WHERE source_id IS NOT NULL;
      CREATE INDEX campaign_test_time ON casino_transactions(platform,lower(username),fecha_hora_utc)
        WHERE tipo='carga' AND monto>0 AND fecha_hora_utc IS NOT NULL;
      CREATE INDEX campaign_test_date ON casino_transactions(platform,lower(username),fecha)
        WHERE tipo='carga' AND monto>0 AND fecha_hora_utc IS NULL;
      INSERT INTO casino_transactions(id,platform,username,tipo,monto,fecha,fecha_hora_utc,source_id,agente)
        SELECT n,'bet30','player','carga',10,'2025-01-01','2025-01-01T12:00:00Z',NULL,'admin'
        FROM generate_series(100,20099) n;
      INSERT INTO casino_transactions(id,platform,username,tipo,monto,fecha,fecha_hora_utc,source_id,agente)
        SELECT n,'bet30','unrelated' || n,'carga',10,'2026-10-01','2026-10-01T12:00:00Z',n::text,'admin'
        FROM generate_series(20100,40099) n;
      ANALYZE casino_transactions;`)
    await deposit(1, '2026-10-01T01:00:00Z')
    await deposit(2, null)
    expect(await stats()).toMatchObject({ efectivos: 1, cargas_24h: 1, cargas_sin_hora: 1, monto_cargado_24h: '100.10' })
    const plan = (await db.query('EXPLAIN (ANALYZE,FORMAT JSON) ' + CAMPAIGN_EFFECTIVENESS_SQL, [[id(1)], false])).rows[0]['QUERY PLAN'][0].Plan
    type Plan = { Plans?: Plan[]; 'Relation Name'?: string; 'Index Name'?: string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number }
    const nodes: Plan[] = []
    const walk = (node: Plan) => { nodes.push(node); node.Plans?.forEach(walk) }
    walk(plan)
    expect(nodes.some(node => node['Index Name'] === 'campaign_test_time')).toBe(true)
    expect(nodes.some(node => node['Index Name'] === 'campaign_test_date')).toBe(true)
    const visited = nodes.filter(node => node['Relation Name'] === 'casino_transactions')
      .reduce((sum,node) => sum + (node['Actual Rows'] + (node['Rows Removed by Filter'] || 0)) * node['Actual Loops'], 0)
    expect(visited).toBeLessThan(100)
  })
})
