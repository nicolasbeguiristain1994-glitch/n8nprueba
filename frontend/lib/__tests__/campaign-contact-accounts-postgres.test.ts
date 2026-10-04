// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { CAMPAIGN_CONTACT_ACCOUNTS_SQL } from '../campaign-contact-accounts'
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
  const links = async (ids: number[]) => (await db.query(`WITH recipients AS (
    SELECT unnest($1::uuid[]) AS contact_id
  ) SELECT * FROM (${CAMPAIGN_CONTACT_ACCOUNTS_SQL}) links ORDER BY contact_id,platform`, [ids.map(id)])).rows

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
})
