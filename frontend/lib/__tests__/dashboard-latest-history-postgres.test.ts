// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Client } from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { latestTransactionDatesSql } from '../dashboard-overview'
import { dashboardAgentSql } from '../dashboard-scope'

describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS !== '1')('bounded latest movement lookup', () => {
  it('matches historical dates for all agents and seeks once per group instead of scanning history', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Local database required')
    const db = new Client({ connectionString: url.toString() })
    await db.connect()
    try {
      await db.query('BEGIN')
      await db.query(`CREATE TEMP TABLE casino_transactions(platform text,agente text,fecha date,fecha_hora_utc timestamptz) ON COMMIT DROP;
        INSERT INTO casino_transactions
        SELECT platform, CASE i%25 WHEN 0 THEN NULL WHEN 1 THEN '  BigWin ' WHEN 2 THEN 'admbigwin' ELSE 'agent-'||i%25 END,
          '2026-01-01'::date+i%270,
          CASE WHEN i%3=0 THEN NULL ELSE '2026-01-01T02:59:59Z'::timestamptz+(i%270)*interval '1 day' END
        FROM unnest(ARRAY['zeus','bet30','ganamos','argenbet','unknown']) platform, generate_series(1,30000) i;
        INSERT INTO casino_transactions VALUES
          ('zeus','no-date',NULL,NULL),('zeus',NULL,'2026-10-01',NULL),
          ('zeus','timestamp-wins','2100-01-01','2026-09-01T02:59:59Z'),
          ('zeus','date-only','2026-09-30',NULL),('zeus','date-only',NULL,NULL),
          ('zeus','bigwin','2026-01-01','2026-10-01T03:00:00Z')`)
      const migration = fs.readFileSync(path.resolve(process.cwd(), '../db/migrations/148_dashboard_latest_movement_index.sql'), 'utf8')
      await db.query(migration.replace('CONCURRENTLY ', '').replaceAll('public.', ''))
      await db.query('ANALYZE casino_transactions')
      for (const platform of ['consolidado', 'zeus'] as const) {
        for (const agent of [null, 'bigwin', 'admbigwin', 'unknown']) {
          const scope = dashboardAgentSql(platform, 1, 't')
          const platformFilter = platform === 'consolidado' ? "IN ('zeus','bet30','ganamos','argenbet')" : "='zeus'"
          const differences = await db.query(`WITH expected AS (
            SELECT platform,agente,GREATEST((MAX(fecha_hora_utc) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
              MAX(fecha) FILTER (WHERE fecha_hora_utc IS NULL)) AS day
            FROM casino_transactions t WHERE t.platform ${platformFilter} AND ${scope} GROUP BY platform,agente
          ), actual AS (SELECT * FROM (${latestTransactionDatesSql(platform)}) t WHERE ${scope})
          SELECT * FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
            UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) differences`, [agent])
          expect(differences.rows, `${platform}/${agent}`).toEqual([])
        }
      }
      const { rows } = await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + latestTransactionDatesSql('consolidado'))
      const scans: Array<{ rows: number; loops: number; index: string }> = []
      const visit = (node: Record<string, any>) => {
        if (node['Relation Name'] === 'casino_transactions') scans.push({
          rows: node['Actual Rows'], loops: node['Actual Loops'], index: node['Index Name'],
        })
        for (const child of node.Plans ?? []) visit(child)
      }
      visit(rows[0]['QUERY PLAN'][0].Plan)
      expect(scans.length).toBeGreaterThan(0)
      expect(scans.every(scan => scan.index === 'idx_casino_latest_movement'), JSON.stringify(scans)).toBe(true)
      // 150,000 movements, only about 100 distinct platform/agent groups.
      expect(scans.reduce((sum, scan) => sum + scan.rows * scan.loops, 0)).toBeLessThan(500)
    } finally { await db.query('ROLLBACK'); await db.end() }
  }, 30000)
})
