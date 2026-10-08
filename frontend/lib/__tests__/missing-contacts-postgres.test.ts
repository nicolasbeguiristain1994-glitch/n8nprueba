// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
vi.mock('@/lib/db', () => ({ getLongRunningClient: vi.fn() }))
import { getLongRunningClient } from '@/lib/db'
import { importMissingContacts, listMissingContacts, readMissingContactFilters, validateMissingContactRows } from '@/lib/missing-contacts'

const admin = { user_id: '00000000-0000-0000-0000-000000000001', role: 'admin' as const, allowed_agents: [] }
const operator = { ...admin, role: 'operator' as const, allowed_agents: ['royal'] }
const filters = (s = '') => readMissingContactFilters(new URLSearchParams(s))
const input = (username: string, phone = '+5491123456789', platform = 'zeus', agent = 'royal') => ({ row: 2, username, phone, platform, agent, name: '' })
const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date"
const schema = `missing_contacts_test_${process.pid}`

describe.skipIf(process.env.RUN_MISSING_CONTACTS_PG_TESTS !== '1')('missing phone workflow on PostgreSQL', () => {
  let db: Client
  async function connection() {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('LOCAL_DATABASE_REQUIRED')
    const client = new Client({ connectionString: url.toString(), ssl: false })
    await client.connect(); await client.query(`SET search_path TO ${schema},public`)
    return client
  }
  beforeAll(async () => {
    db = await connection()
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
      CREATE TABLE casino_players(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),username text NOT NULL,
        username_lower text GENERATED ALWAYS AS (lower(username)) STORED,platform text,agente text,
        total_cargas numeric DEFAULT 0,total_retiros numeric DEFAULT 0,cant_cargas int DEFAULT 0,cant_retiros int DEFAULT 0,
        fecha_primera date,fecha_ultima date,seg_monto text,seg_actividad text, UNIQUE(username_lower));
      CREATE TABLE casino_transactions(id bigserial PRIMARY KEY,platform text,username text,agente text,tipo text,monto numeric DEFAULT 10,fecha date,fecha_hora_utc timestamptz,source_id text DEFAULT 'fixture');
      CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),external_id text UNIQUE,phone_number text UNIQUE,
        first_name text,last_name text,panel text,panels_assigned text[] DEFAULT '{}',casino_accounts jsonb DEFAULT '[]',
        status text DEFAULT 'active',opt_in_marketing boolean DEFAULT true,do_not_contact boolean DEFAULT false,
        platform_source text,deleted_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid);
      INSERT INTO casino_players(username,platform,agente) VALUES('historical','zeus','royal');`)
    await db.query('BEGIN')
    await db.query(readFileSync('../db/migrations/145_casino_players_first_seen.sql','utf8'))
    await db.query('COMMIT')
    expect((await db.query('SELECT first_seen_at FROM casino_players')).rows[0].first_seen_at).toBeNull()
    const migration = readFileSync('../db/migrations/126_casino_excel_import.sql','utf8')
    await db.query(migration.slice(migration.indexOf('CREATE OR REPLACE VIEW casino_segmentation_players'), migration.indexOf('CREATE OR REPLACE FUNCTION preserve_explicit_casino_platforms')))
    vi.mocked(getLongRunningClient).mockImplementation(connection)
  })
  beforeEach(async () => {
    await db.query(`TRUNCATE contacts,casino_players,casino_transactions,operator_contact_visibility;
      INSERT INTO casino_players(username,platform,agente,fecha_ultima,first_seen_at) VALUES
        ('active','zeus','royal',${today}-5,NULL),('old','zeus','royal',${today}-400,NULL),
        ('withdrawal','zeus','royal',${today}-400,NULL),('known','zeus','royal',${today}-1,NULL),
        ('shared','zeus','royal',${today}-2,NULL),
        ('otheragent','zeus','bigwin',${today}-1,NULL),('future','zeus','royal',${today}+10,NULL),
        ('unknown','zeus','royal',NULL,NULL),('internal','zeus','adminbet',${today},NULL),
        ('newuser','ganamos','adminroyal',NULL,now()),('royal','zeus','royal',${today},NULL);
      INSERT INTO casino_transactions(platform,username,agente,tipo,fecha) VALUES
        ('bet30','shared','zeusroyal','carga',${today}-2),
        ('zeus','withdrawal','royal','retiro',${today}-4),
        ('argenbet','txonly','adminroyal','carga',${today}-3);
      INSERT INTO contacts(phone_number,first_name,panel,casino_accounts) VALUES
        ('+5491100000001','known','royal','[]'),
        ('+5491100000002','shared','royal','[{"username":"shared","platform":"zeus","panel":"royal"}]');`)
  })
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end() } })

  it('includes deposits, withdrawals, transaction-only accounts and newly detected profiles', async () => {
    const data = await listMissingContacts(admin, filters())
    expect(data.total).toBe(6)
    expect(data.users.map(r => `${r.platform}:${r.username}`).sort()).toEqual([
      'argenbet:txonly','bet30:shared','ganamos:newuser','zeus:active','zeus:otheragent','zeus:withdrawal',
    ])
    expect((await listMissingContacts(admin, filters('include_new=false'))).total).toBe(5)
    expect((await listMissingContacts(admin, filters('months=0&agent=royal'))).users.some(r => r.username === 'old')).toBe(true)
  })
  it('keeps platform identities and canonical agent filters in list and export', async () => {
    const data = await listMissingContacts(operator, filters('platform=bet30&agent=royal'))
    expect(data.users.map(r => [r.username,r.agent,r.source_agent])).toEqual([['shared','royal','zeusroyal']])
    const list = await listMissingContacts(admin, filters('agent=royal'))
    const exported = await listMissingContacts(admin, filters('agent=royal'), true)
    expect(list.users).toEqual(exported.users)
    expect((await listMissingContacts(operator, filters('agent=bigwin'))).total).toBe(0)
  })
  it('respects explicit contact-only visibility and denies unassigned operators', async () => {
    expect((await listMissingContacts({ ...operator, allowed_agents: [] },filters())).total).toBe(0)
    await db.query('INSERT INTO operator_contact_visibility(operator_id) VALUES($1)',[operator.user_id])
    expect((await listMissingContacts(operator,filters())).total).toBe(0)
    expect((await importMissingContacts(operator,[input('active')],false)).errors).toHaveLength(1)
  })
  it('returns a total on empty pages and updates automatically after new activity', async () => {
    expect(await listMissingContacts(admin,filters('page=20'))).toMatchObject({ users: [],total: 6 })
    await db.query(`INSERT INTO casino_transactions(platform,username,agente,tipo,fecha) VALUES('zeus','brandnew','royal','carga',${today})`)
    expect((await listMissingContacts(admin,filters())).total).toBe(7)
  })
  it('uses the six calendar month boundary, inclusive, and the Argentina day', async () => {
    await db.query(`INSERT INTO casino_players(username,platform,agente,fecha_ultima,first_seen_at) VALUES
      ('boundary','zeus','royal',(${today}-interval '6 months')::date,NULL),
      ('outside','zeus','royal',(${today}-interval '6 months')::date-1,NULL);
      INSERT INTO casino_transactions(platform,username,agente,tipo,fecha,fecha_hora_utc) VALUES
      ('zeus','timestamp','royal','retiro',${today}+1,(${today}::timestamp+interval '1 day 1 hour') AT TIME ZONE 'UTC');`)
    const data = await listMissingContacts(admin,filters('include_new=false'))
    expect(data.users.some(r => r.username==='boundary')).toBe(true)
    expect(data.users.some(r => r.username==='outside')).toBe(false)
    const timestamp = data.users.find(r => r.username==='timestamp')!
    expect(timestamp.last_movement).toBe((await db.query(`SELECT ${today}::text AS day`)).rows[0].day)
  })
  it('previews without mutation and imports an explicit identity, then removes it from pending', async () => {
    const rows = [input('shared','54 9 11 1234-5678','bet30')]
    expect(await importMissingContacts(admin,rows,true)).toMatchObject({ ready: 1, inserted: 0, dryRun: true })
    expect((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(2)
    expect(await importMissingContacts(admin,rows,false)).toMatchObject({ ready: 1, inserted: 1, linked: 1 })
    expect((await listMissingContacts(admin,filters())).users.some(r => r.username === 'shared')).toBe(false)
    expect((await db.query("SELECT casino_accounts FROM contacts WHERE phone_number='+5491112345678'")).rows[0].casino_accounts).toEqual([{ username: 'shared',platform: 'bet30',panel: 'royal' }])
    expect(await importMissingContacts(admin,rows,false)).toMatchObject({ inserted: 0, linked: 0, unchanged: 1 })
  })
  it('merges multiple accounts into one phone and preserves preferences and existing identity', async () => {
    await db.query(`UPDATE contacts SET first_name='Nombre conservado',status='blocked',opt_in_marketing=false,do_not_contact=true,
      casino_accounts='[{"username":"known","platform":"zeus","panel":"royal"}]' WHERE phone_number='+5491100000001'`)
    const result = await importMissingContacts(admin,[input('active','+5491100000001'),input('withdrawal','+5491100000001')],false)
    expect(result).toMatchObject({ inserted: 0, linked: 2, errors: [] })
    const c = (await db.query("SELECT * FROM contacts WHERE phone_number='+5491100000001'")).rows[0]
    expect(c).toMatchObject({ first_name: 'Nombre conservado',status: 'blocked',opt_in_marketing: false,do_not_contact: true })
    expect(c.casino_accounts).toHaveLength(3)
    expect((await listMissingContacts(admin,filters())).total).toBe(4)
  })
  it('reports blanks, malformed phones, conflicting duplicates and wrong agents per row', async () => {
    const rows = [input('active',''),input('withdrawal','123'),input('shared','+5491123456000','bet30','bigwin'),
      input('otheragent','+5491123456001','zeus','bigwin'),input('otheragent','+5491123456002','zeus','bigwin'),input('txonly','+5491123456003','argenbet')]
    const result = await importMissingContacts(admin,rows,false)
    expect(result).toMatchObject({ blank: 1, inserted: 1, linked: 1 })
    expect(result.errors).toHaveLength(4)
  })
  it('rejects reassignment and deleted or inaccessible phone conflicts', async () => {
    expect((await importMissingContacts(admin,[input('known','+5491199999999')],false)).errors).toHaveLength(1)
    await db.query("UPDATE contacts SET deleted_at=now() WHERE phone_number='+5491100000001'")
    expect((await importMissingContacts(admin,[input('active','+5491100000001')],false)).errors).toHaveLength(1)
    await db.query("UPDATE contacts SET deleted_at=NULL,panel='bigwin' WHERE phone_number='+5491100000001'")
    expect((await importMissingContacts(operator,[input('active','+5491100000001')],false)).errors).toHaveLength(1)
  })
  it('deduplicates repeated accounts and creates one contact for multiple platform accounts', async () => {
    const result = await importMissingContacts(admin,[input('active'),input('active'),input('shared',undefined,'bet30')],false)
    expect(result).toMatchObject({ inserted: 1,linked: 2,unchanged: 1 })
  })
  it('serializes concurrent account imports so only one phone becomes linked', async () => {
    const results = await Promise.all([
      importMissingContacts(admin,[input('active','+5491123400001')],false),
      importMissingContacts(admin,[input('active','+5491123400002')],false),
    ])
    expect(results.reduce((n,r) => n+r.inserted,0)).toBe(1)
    expect(results.reduce((n,r) => n+r.errors.length,0)).toBe(1)
  })
  it('rolls the entire transaction back on database failure', async () => {
    await db.query(`CREATE FUNCTION reject_test_phone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.phone_number='+5491199999999' THEN RAISE EXCEPTION 'TEST_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_phone BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION reject_test_phone()`)
    try {
      await expect(importMissingContacts(admin,[input('active','+5491188888888'),input('withdrawal','+5491199999999')],false)).rejects.toThrow('TEST_FAILURE')
      expect((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(2)
    } finally { await db.query('DROP TRIGGER reject_test_phone ON contacts; DROP FUNCTION reject_test_phone()') }
  })
})

it('validates filter bounds and malformed payloads', () => {
  expect(filters().months).toBe(6)
  for (const query of ['months=-1','months=abc','page=0','page=1.1','platform=bad','agent=bad']) expect(() => filters(query)).toThrow()
  for (const rows of [null,[],[{}],[{...input('a'),phone:123}]]) expect(() => validateMissingContactRows(rows)).toThrow()
  expect(validateMissingContactRows([input('PLAYER')])[0].username).toBe('player')
})
