import { financialLedgerSql } from './dashboard-financial-ledger'
import { DASHBOARD_TIMEZONE, dashboardAgentSql, movementPeriodSql } from './dashboard-scope'
import { getPlatformFilterSql, type Platform, type SyncPlatform } from './casino-agents'

export interface PlatformActivity {
  platform: SyncPlatform
  agente: string | null
  bonos?: string
  saldo_con_bonos?: string
  depositos: string
  retiros: string
  neto: string
  movimientos: number
  cuentas: number
  ultima_fecha: string | null
}

/** GROUPING SETS counts accounts once per platform, even if they changed agent. */
export function overviewSql(platform: Platform): string {
  const scope = (alias: string) => `${getPlatformFilterSql(platform, alias)} AND ${dashboardAgentSql(platform, 3, alias)}`
  // Keep the predicates inside each UNION branch. Filtering the full ledger after
  // UNION can force PostgreSQL to join/normalize years of unrelated movements.
  const period = (alias: string) => `${scope(alias)} AND ${movementPeriodSql(alias)}`
  return `WITH ledger AS (${financialLedgerSql(period)}), period_totals AS (
    SELECT platform, agente, GROUPING(agente) AS platform_total,
      SUM(monto) FILTER (WHERE tipo='carga') AS depositos,
      SUM(monto) FILTER (WHERE tipo='retiro') AS retiros,
      SUM(CASE WHEN tipo='carga' THEN monto WHEN tipo='retiro' THEN -monto ELSE 0 END) AS neto,
      SUM(monto) FILTER (WHERE tipo='bono') AS bonos,
      SUM(CASE WHEN tipo IN ('carga','bono') THEN monto WHEN tipo='retiro' THEN -monto ELSE 0 END) AS saldo_con_bonos,
      COUNT(*)::int AS movimientos, COUNT(DISTINCT LOWER(username))::int AS cuentas
    FROM ledger GROUP BY GROUPING SETS ((platform), (platform, agente))
  ), history_dates AS (
    SELECT t.platform, t.agente,
      GREATEST((MAX(t.fecha_hora_utc) AT TIME ZONE '${DASHBOARD_TIMEZONE}')::date,
        MAX(t.fecha) FILTER (WHERE t.fecha_hora_utc IS NULL)) AS day
    FROM casino_transactions t WHERE ${scope('t')} GROUP BY t.platform,t.agente
    UNION ALL
    SELECT f.platform, f.agente,
      GREATEST((MAX(f.fecha_hora_utc) AT TIME ZONE '${DASHBOARD_TIMEZONE}')::date,
        MAX(f.fecha) FILTER (WHERE f.fecha_hora_utc IS NULL)) AS day
    FROM casino_financial_source_records f WHERE f.kind='bono' AND ${scope('f')} GROUP BY f.platform,f.agente
  ), latest AS (
    SELECT platform, agente, GROUPING(agente) AS platform_total, MAX(day)::text AS ultima_fecha
    FROM history_dates GROUP BY GROUPING SETS ((platform), (platform, agente))
  ) SELECT l.platform,
    CASE WHEN l.platform_total=1 THEN NULL ELSE COALESCE(l.agente, 'Sin agente') END AS agente,
    COALESCE(p.depositos,0)::text AS depositos, COALESCE(p.retiros,0)::text AS retiros,
    COALESCE(p.neto,0)::text AS neto, COALESCE(p.bonos,0)::text AS bonos,
    COALESCE(p.saldo_con_bonos,0)::text AS saldo_con_bonos,
    COALESCE(p.movimientos,0)::int AS movimientos, COALESCE(p.cuentas,0)::int AS cuentas,
    l.ultima_fecha
    FROM latest l LEFT JOIN period_totals p ON p.platform=l.platform
      AND p.platform_total=l.platform_total AND p.agente IS NOT DISTINCT FROM l.agente
    ORDER BY l.platform, agente NULLS FIRST`
}
