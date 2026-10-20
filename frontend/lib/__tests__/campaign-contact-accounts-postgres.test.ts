// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { CAMPAIGN_CONTACT_ACCOUNTS_SQL, contactAccountLinksSql } from '../campaign-contact-accounts'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`

describe.skipIf(!process.env.OPS_TEST_DATABASE_URL && process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('scoped campaign account identities', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL((process.env.OPS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL)!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({connectionString:url.toString(),ssl:false}); await db.connect()
    await db.query(`BEGIN;
      CREATE TEMP TABLE contacts(id uuid,first_name text,last_name text,casino_accounts jsonb,deleted_at timestamptz);
      CREATE TEMP TABLE casino_players(id uuid,platform text,username_lower text,agente text);
      CREATE TEMP TABLE casino_transactions(id bigint,platform text,username text,source_id text,agente text,fecha_hora_utc timestamptz);
      INSERT INTO casino_players VALUES
        ('${id(101)}','bet30','shared','adminroyal'),('${id(102)}','zeus','shared','adminfara'),
        ('${id(103)}','ganamos','unique','adminbtc'),('${id(104)}','bet30','royal','adminroyal');
      INSERT INTO contacts VALUES
        ('${id(1)}','shared',NULL,'[{"username":"SHARED","platform":"bet30"}]',NULL),
        ('${id(2)}','shared',NULL,'[]',NULL),
        ('${id(3)}',NULL,NULL,'[{"username":"shared","panel":"royal"}]',NULL),
        ('${id(4)}','unique',NULL,'[]',NULL),
        ('${id(5)}','unique',NULL,'[{"username":"unique","platform":"zeus"}]',NULL),
        ('${id(6)}','royal',NULL,'[]',NULL),
        ('${id(7)}',NULL,NULL,'[{"username":"unique"}]',NULL),
        ('${id(8)}','unique',NULL,'[]',NOW()),
        ('${id(9)}','unique',NULL,'[]',NULL);`)
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  const links = async (ids: number[]) => {
    const read = async (sql: string) => (await db.query(`WITH recipients AS (
      SELECT unnest($1::uuid[]) AS contact_id
    ) SELECT * FROM (${sql}) links ORDER BY contact_id,platform`, [ids.map(id)])).rows
    const scoped = await read(CAMPAIGN_CONTACT_ACCOUNTS_SQL)
    expect(await read(contactAccountLinksSql(true))).toEqual(scoped)
    return scoped
  }

  it('resolves explicit platform, unique panel, unambiguous name and username-only accounts', async () => {
    expect(await links([1,3,4,7])).toEqual([
      {contact_id:id(1),platform:'bet30',username_lower:'shared'},
      {contact_id:id(3),platform:'bet30',username_lower:'shared'},
      {contact_id:id(4),platform:'ganamos',username_lower:'unique'},
      {contact_id:id(7),platform:'ganamos',username_lower:'unique'},
    ])
  })
  it('retains cross-platform ambiguity even when only one contact was broadcast', async () => {
    expect(await links([2])).toEqual([])
  })
  it('excludes contradictory accounts, agent names, deleted and unrequested contacts', async () => {
    expect(await links([5,6,8])).toEqual([])
    expect(await links([4])).toHaveLength(1)
    expect(await links([])).toEqual([])
  })
  it('preserves imported-account precedence, latest agent and ambiguity across platforms', async () => {
    await db.query('SAVEPOINT imports')
    try {
      await db.query(`INSERT INTO casino_players VALUES
        ('${id(110)}','bet30','imported','adminbtc'),
        ('${id(111)}',NULL,'legacy','adminroyal');
        INSERT INTO casino_transactions VALUES
        (1,'bet30','IMPORTED','source-1','adminfara','2026-09-01T12:00:00Z'),
        (2,'bet30','imported','source-2','adminroyal','2026-09-02T12:00:00Z'),
        (3,'bet30','imported','source-3','adminfara','2026-09-02T12:00:00Z'),
        (4,'zeus','unique','source-4','adminzeus','2026-09-02T12:00:00Z'),
        (5,'bet30','legacy','source-5','adminroyal','2026-09-02T12:00:00Z'),
        (6,'ganamos','legacy',NULL,'adminbtc','2026-09-02T12:00:00Z');
        INSERT INTO contacts VALUES
        ('${id(10)}',NULL,NULL,'[{"username":"imported","panel":"farabet"}]',NULL),
        ('${id(11)}',NULL,NULL,'[{"username":"imported","panel":"betcoin"}]',NULL),
        ('${id(12)}','imported',NULL,'[]',NULL),
        ('${id(13)}','legacy',NULL,'[]',NULL);`)
      expect(await links([10,11,12,13])).toEqual([
        {contact_id:id(10),platform:'bet30',username_lower:'imported'},
        {contact_id:id(12),platform:'bet30',username_lower:'imported'},
        {contact_id:id(13),platform:'bet30',username_lower:'legacy'},
      ])
      // A newly imported namesake on another platform must invalidate name-only
      // matching, even though no recipient explicitly names that platform.
      expect(await links([4])).toEqual([])
    } finally { await db.query('ROLLBACK TO SAVEPOINT imports') }
  })
  const compoundLinks = async (ids: number[], enabled = true) =>
    (await db.query(`WITH recipients AS (SELECT unnest($1::uuid[]) AS contact_id)
      SELECT * FROM (${contactAccountLinksSql(false, false, enabled)}) links
      ORDER BY contact_id,platform,username_lower`, [ids.map(id)])).rows

  it('attributes literal accounts inside compound imports, including parentheses, notes and ñ', async () => {
    await db.query('SAVEPOINT compound')
    try {
      await db.query(`ALTER TABLE contacts ADD account_username text;
        INSERT INTO casino_players VALUES
          ('${id(201)}','zeus','sample95z','royal'),
          ('${id(202)}','bet30','sample95bt','zeusroyal'),
          ('${id(203)}','zeus','sample323z','royal'),
          ('${id(204)}','zeus','sampleño94z','royal'),
          ('${id(205)}','bet30','sampleño94b','zeusroyal'),
          ('${id(206)}','zeus','sample41zs','royal'),
          ('${id(207)}','zeus','sample82zs','royal');
        INSERT INTO contacts(id,first_name,casino_accounts,account_username) VALUES
          ('${id(20)}','sample95bt sample95z','[{"username":"sample95bt sample95z","panel":"royal"}]','sample95bt sample95z'),
          ('${id(21)}','sample323z(Zeus Y Fara)','[{"username":"sample323z(Zeus Y Fara)","panel":"royal"}]','sample323z(zeus y fara)'),
          ('${id(22)}','sampleño94z // sampleño94b','[{"username":"sampleño94z // sampleño94b","panel":"royal"}]','sampleño94z // sampleño94b'),
          ('${id(23)}','Sample82zs Mismo Titular Sample41zs','[{"username":"Sample82zs Mismo Titular Sample41zs","panel":"royal"}]','sample82zs mismo titular sample41zs');`)
      expect(await compoundLinks([20,21,22,23])).toEqual([
        {contact_id:id(20),platform:'bet30',username_lower:'sample95bt'},
        {contact_id:id(20),platform:'zeus',username_lower:'sample95z'},
        {contact_id:id(21),platform:'zeus',username_lower:'sample323z'},
        {contact_id:id(22),platform:'bet30',username_lower:'sampleño94b'},
        {contact_id:id(22),platform:'zeus',username_lower:'sampleño94z'},
        {contact_id:id(23),platform:'zeus',username_lower:'sample82zs'},
        {contact_id:id(23),platform:'zeus',username_lower:'sample41zs'},
      ])
      // This recovery is limited to statistics, not audience selection.
      expect(await compoundLinks([20,21,22,23],false)).toEqual([])
    } finally { await db.query('ROLLBACK TO SAVEPOINT compound') }
  })
  it('preserves exact identities, platform/agent restrictions and ambiguous compound names', async () => {
    await db.query('SAVEPOINT compound_safety')
    try {
      await db.query(`ALTER TABLE contacts ADD account_username text;
        INSERT INTO casino_players VALUES
          ('${id(210)}','zeus','whole12/other34','royal'),
          ('${id(211)}','zeus','whole12','royal'),
          ('${id(212)}','zeus','other34','royal'),
          ('${id(213)}','bet30','multi99','royal'),
          ('${id(214)}','zeus','multi99','royal'),
          ('${id(215)}','zeus','fara88','farabet'),
          ('${id(216)}','zeus','nota77','royal');
        INSERT INTO contacts(id,first_name,casino_accounts,account_username) VALUES
          ('${id(30)}','whole12/other34','[{"username":"whole12/other34","panel":"royal"}]','whole12/other34'),
          ('${id(31)}','multi99 / fara88','[{"username":"multi99 / fara88","panel":"royal"}]','multi99 / fara88'),
          ('${id(32)}','other34 / nota77','[{"username":"other34 / nota77","platform":"bet30","panel":"royal"}]','other34 / nota77'),
          ('${id(33)}','multi99 / fara88','[{"username":"multi99 / fara88","platform":"bet30","panel":"royal"}]','multi99 / fara88');`)
      expect(await compoundLinks([30,31,32,33])).toEqual([
        {contact_id:id(30),platform:'zeus',username_lower:'whole12/other34'},
        {contact_id:id(33),platform:'bet30',username_lower:'multi99'},
      ])
    } finally { await db.query('ROLLBACK TO SAVEPOINT compound_safety') }
  })
})
