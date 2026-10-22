import { previousMonthRange } from './dashboard-date-range'
import { financialLedgerSql } from './dashboard-financial-ledger'
import { dashboardAgents, dashboardAgentSql, movementDateSql, movementPeriodSql, platformCanonicalAgentSql } from './dashboard-scope'
import { getPlatformFilterSql, type Platform } from './casino-agents'
import { query } from './db'
import type { AgentSalesComparison, CasinoAgente } from './dashboard-casino'

export interface DashboardAgentSummary {
  sales_comparison: AgentSalesComparison
  agentes: Pick<CasinoAgente, 'agente' | 'nuevos_mes'>[]
}

/** The two leading cards need cash totals and first-deposit dates, not player
 * segmentation or cash rankings. Group raw accounts before resolving aliases. */
export async function casinoAgentSummary(platform: Platform, from: string, to: string, agent: string | null, runQuery: typeof query = query): Promise<DashboardAgentSummary> {
  const previous = previousMonthRange(from, to)
  const scope = (alias: string) => `${getPlatformFilterSql(platform, alias)} AND ${dashboardAgentSql(platform, 3, alias)}`
  const canonical = (alias: string) => platform === 'consolidado' ? platformCanonicalAgentSql(alias) : `${alias}.agente`
  const result = await runQuery<{ dashboard: DashboardAgentSummary }>(`
    WITH raw_sales AS MATERIALIZED (
      SELECT platform, LOWER(BTRIM(agente)) AS agente,
        COALESCE(SUM(monto) FILTER (WHERE tipo='carga' AND ${movementDateSql()} BETWEEN $1::date AND $2::date),0) AS amount,
        COALESCE(SUM(monto) FILTER (WHERE tipo='carga' AND ${movementDateSql()} BETWEEN $4::date AND $5::date),0) AS previous_amount,
        BOOL_OR(tipo='carga') AS has_sales,
        BOOL_OR(${movementDateSql()} BETWEEN $1::date AND $2::date) AS current_account
      FROM (${financialLedgerSql(alias => `${scope(alias)} AND (${movementPeriodSql(alias)} OR ${movementPeriodSql(alias, '$4::date', '$5::date')})`)}) ledger
      GROUP BY platform, LOWER(BTRIM(agente))
    ), sales_totals AS (
      SELECT COALESCE(${canonical('r')},'Sin agente') AS agente, SUM(amount) AS amount, SUM(previous_amount) AS previous_amount
      FROM raw_sales r WHERE has_sales GROUP BY 1
    ), sales_agents AS (
      SELECT unnest($6::text[]) AS agente UNION SELECT agente FROM sales_totals
    ), sales AS (
      SELECT a.agente, COALESCE(s.amount,0)::text AS amount, COALESCE(s.previous_amount,0)::text AS previous_amount,
        (COALESCE(s.amount,0)-COALESCE(s.previous_amount,0))::text AS difference,
        CASE WHEN s.previous_amount<>0 THEN ROUND(100*(s.amount-s.previous_amount)/ABS(s.previous_amount),2)::text
          WHEN COALESCE(s.amount,0)=0 THEN '0' ELSE NULL END AS change_percentage
      FROM sales_agents a LEFT JOIN sales_totals s USING(agente)
      ORDER BY COALESCE(s.amount,0) DESC, a.agente
    ), raw_firsts AS (
      SELECT platform, agente, COUNT(*)::int AS nuevos_mes
      FROM (SELECT platform, first_deposit_agent AS agente, fecha_primera FROM casino_dashboard_players) cp
      WHERE ${getPlatformFilterSql(platform, 'cp')} AND fecha_primera BETWEEN $1::date AND $2::date
        AND ${dashboardAgentSql(platform, 3, 'cp')}
      GROUP BY platform, agente
    ), firsts AS (
      SELECT ${canonical('f')} AS agente, SUM(nuevos_mes)::int AS nuevos_mes FROM raw_firsts f GROUP BY 1
    ), current_agents AS (
      SELECT ${canonical('p')} AS agente FROM (
        SELECT DISTINCT platform, agente FROM casino_dashboard_players cp WHERE ${scope('cp')}
      ) p
      UNION SELECT ${canonical('r')} FROM raw_sales r WHERE current_account
      UNION SELECT agente FROM firsts
    ), new_users AS (
      SELECT a.agente, COALESCE(f.nuevos_mes,0)::int AS nuevos_mes
      FROM current_agents a LEFT JOIN firsts f USING(agente) ORDER BY a.agente
    )
    SELECT json_build_object(
      'sales_comparison',json_build_object('previous',json_build_object('from',$4::text,'to',$5::text),'rows',COALESCE((SELECT json_agg(s) FROM sales s),'[]'::json)),
      'agentes',COALESCE((SELECT json_agg(n) FROM new_users n),'[]'::json)
    ) AS dashboard
  `,
  [from, to, agent, previous.from, previous.to, agent ? [agent] : dashboardAgents(platform)])
  return result[0].dashboard
}
