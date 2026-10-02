// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { Client } from 'pg'
import { dashboardAgentSql, movementDateSql, movementPeriodSql, platformCanonicalAgentSql } from '../dashboard-scope'

describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS !== '1')('indexed dashboard predicates', () => {
  it('matches the original operator mapping and calendar predicates, including unknown aliases and inconsistent stored dates', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1','localhost'].includes(url.hostname)) throw Error('Local only')
    const db = new Client({connectionString:url.toString()}); await db.connect()
    try {
      const sql = `WITH rows AS (
        SELECT platform, agente FROM unnest(ARRAY['zeus','bet30','ganamos','argenbet','unknown',NULL]) platform
        CROSS JOIN unnest(ARRAY['royal','zeusroyal','adminroyal','btcuno','betcoin','btcdos','farabet','zeus','ofizeus','adminzeus','adminbtc','admbigwin','adminfara','amdfarabet','admfarabet','adminimperio','other','  ADMINROYAL ',NULL]) agente
      ) SELECT COUNT(*)::int AS differences FROM rows r
      WHERE ((${dashboardAgentSql('consolidado',1,'r')}) IS TRUE) IS DISTINCT FROM
        (($1::text IS NULL OR ${platformCanonicalAgentSql('r')}=$1) IS TRUE)`
      for (const agent of [null,'royal','zeusroyal','adminroyal','btcuno','betcoin','btcdos','farabet','zeus','ofizeus','bigwin','imperio','other']) {
        expect((await db.query(sql,[agent])).rows[0].differences, String(agent)).toBe(0)
      }
      const period = `WITH rows AS (
        SELECT fecha, fecha_hora_utc FROM generate_series('2026-08-30'::date,'2026-10-02'::date,'1 day') date_source
        CROSS JOIN LATERAL (SELECT date_source::date AS fecha) d
        CROSS JOIN unnest(ARRAY[NULL::timestamptz,'2026-09-01T02:59:59.999999Z','2026-09-01T03:00:00Z','2026-10-01T02:59:59.999999Z','2026-10-01T03:00:00Z']) fecha_hora_utc
      ) SELECT COUNT(*)::int AS differences FROM rows r
        WHERE (${movementPeriodSql('r')}) IS DISTINCT FROM (${movementDateSql('r')} BETWEEN $1::date AND $2::date)`
      expect((await db.query(period,['2026-09-01','2026-09-30'])).rows[0].differences).toBe(0)
    } finally { await db.end() }
  })
})
