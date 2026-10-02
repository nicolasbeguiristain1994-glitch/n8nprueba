import { financialLedgerSql } from '@/lib/dashboard-financial-ledger'
import { dashboardAgent, dashboardAgentSql, movementDateSql, movementPeriodSql, platformCanonicalAgentSql } from '@/lib/dashboard-scope'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getPlatformFilterSql, isValidPlatform } from '@/lib/casino-agents'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CasinoSummary {
  nuevos_mes:              number  // primer depósito registrado en el período
  activos_mes:             number  // cuenta con movimientos en el período
  nuevos_anterior:         number  // período anterior de igual duración
  activos_anterior:        number  // movimientos del período anterior
  total_vip:               number  // todos los niveles VIP
  prioridad_reactivacion:  number  // super_vip/vip + inactivo/en_riesgo/perdido
  total_jugadores:         number
}

export interface CasinoAgente {
  agente:        string
  total:         number
  nuevos_mes:    number
  activos_mes:   number
  vip:           number
  en_riesgo:     number   // inactivo + en_riesgo + perdido
  sum_cargas:    number   // depósitos del período
  sum_retiros:   number   // retiros del período
  avg_cargas:    number   // promedio de cargas por jugador
  response_rate: number   // % jugadores con actividad en el período (activos_mes / total)
  reload_rate:   number   // % jugadores con al menos 1 depósito en el período
}

export interface CasinoVip {
  username:      string
  platform:      string | null   // identidad compuesta (platform, username) — D2
  agente:        string
  seg_monto:     string  // 'super_vip' | 'vip'
  seg_actividad: string
  dias_ultimo:   number  // CURRENT_DATE - fecha_ultima
  total_cargas:  number
  cant_cargas:   number
  total_retiros: number
  cant_retiros:  number
  fecha_ultima:  string
}

export interface SegCount { seg: string; cnt: number }
export interface CasinoDashboardData { summary: CasinoSummary; agentes: CasinoAgente[]; vips: CasinoVip[]; seg_actividad: SegCount[]; seg_monto: SegCount[] }

// Period KPIs use the transaction ledger; segmentation describes the current state.
export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err
  const params = new URL(req.url).searchParams
  const platform = params.get('platform')?.trim() || 'zeus'
  const from = params.get('from') ?? shiftDate(argentinaToday(), -29)
  const to = params.get('to') ?? argentinaToday()
  if (!isValidPlatform(platform) || !validDateRange(from, to)) {
    return NextResponse.json({ error: 'Plataforma o período inválido' }, { status: 400 })
  }
  const agent = dashboardAgent(platform, params.get('agent') || '') || null
  const filter = getPlatformFilterSql(platform)
  const cpFilter = getPlatformFilterSql(platform, 'cp')
  const agentExpr = platform === 'consolidado' ? platformCanonicalAgentSql('a') : 'a.agente'
  const vipLevels = "('super_vip','vip_alto','vip_medio','vip')"
  const scopedAccounts = `SELECT * FROM casino_dashboard_players cp WHERE ${cpFilter}`
  // Both period consumers share the same bounded ledger. Without this scope,
  // PostgreSQL scans the complete transaction history twice for every refresh.
  const ledgerScope = (alias: string) => `${getPlatformFilterSql(platform, alias)}
    AND ${dashboardAgentSql(platform, 3, alias)}
    AND ${movementPeriodSql(alias, '$1::date - ($2::date - $1::date + 1)')}`
  try {
    // The account projection is maintained atomically with ledger writes.
    // First deposits belong to their original agent; VIP/risk use the current agent.
    const result = await query<{ dashboard: CasinoDashboardData }>(`
      WITH ledger AS MATERIALIZED (${financialLedgerSql(ledgerScope)}), all_players AS MATERIALIZED (${scopedAccounts}),
      players AS MATERIALIZED (SELECT * FROM all_players cp WHERE ${dashboardAgentSql(platform, 3, 'cp')}),
      firsts AS MATERIALIZED (
        SELECT * FROM (SELECT platform,username_lower,first_deposit_agent AS agente,fecha_primera FROM all_players) cp
        WHERE fecha_primera IS NOT NULL AND ${dashboardAgentSql(platform, 3, 'cp')}
      ),
      summary AS (
        WITH activity AS (
          SELECT platform, LOWER(username) AS uname,
            BOOL_OR(${movementDateSql()} BETWEEN $1::date AND $2::date) AS current_active,
            BOOL_OR(${movementDateSql()} < $1::date) AS previous_active
          FROM ledger
          WHERE ${filter} AND ${dashboardAgentSql(platform, 3)}
            AND ${movementDateSql()} BETWEEN ($1::date - ($2::date - $1::date + 1)) AND $2::date
          GROUP BY platform, LOWER(username)
        )
        SELECT
          (SELECT COUNT(*)::int FROM firsts WHERE fecha_primera BETWEEN $1::date AND $2::date) AS nuevos_mes,
          (SELECT COUNT(*)::int FROM activity WHERE current_active) AS activos_mes,
          (SELECT COUNT(*)::int FROM firsts WHERE fecha_primera BETWEEN ($1::date - ($2::date - $1::date + 1)) AND ($1::date - 1)) AS nuevos_anterior,
          (SELECT COUNT(*)::int FROM activity WHERE previous_active) AS activos_anterior,
          COUNT(*) FILTER (WHERE cp.seg_monto IN ${vipLevels})::int AS total_vip,
          COUNT(*) FILTER (WHERE cp.seg_monto IN ${vipLevels} AND cp.seg_actividad IN ('inactivo','en_riesgo','perdido'))::int AS prioridad_reactivacion,
          COUNT(*)::int AS total_jugadores
        FROM players cp
        WHERE ${cpFilter} AND ${dashboardAgentSql(platform, 3, 'cp')}
      ),
      agents AS (
        WITH period_tx AS (
          SELECT platform, LOWER(BTRIM(agente)) AS agente, LOWER(username) AS uname,
            SUM(CASE WHEN tipo = 'carga' THEN monto ELSE 0 END) AS carga_total,
            SUM(CASE WHEN tipo = 'retiro' THEN monto ELSE 0 END) AS retiro_total,
            BOOL_OR(tipo = 'carga') AS has_carga
          FROM ledger
          WHERE ${movementDateSql()} BETWEEN $1::date AND $2::date AND ${filter}
            AND ${dashboardAgentSql(platform, 3)}
          GROUP BY platform, LOWER(BTRIM(agente)), LOWER(username)
        ), accounts AS (
          SELECT platform, agente, username_lower AS uname FROM players
          UNION SELECT platform, agente, uname FROM period_tx
          UNION SELECT platform, agente, username_lower FROM firsts WHERE fecha_primera BETWEEN $1::date AND $2::date
        )
        SELECT ${agentExpr} AS agente, COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE fp.fecha_primera BETWEEN $1::date AND $2::date)::int AS nuevos_mes,
          COUNT(ct.uname)::int AS activos_mes,
          COUNT(*) FILTER (WHERE cp.seg_monto IN ${vipLevels})::int AS vip,
          COUNT(*) FILTER (WHERE cp.seg_actividad IN ('inactivo','en_riesgo','perdido'))::int AS en_riesgo,
          COALESCE(SUM(ct.carga_total),0)::float8 AS sum_cargas,
          COALESCE(SUM(ct.retiro_total),0)::float8 AS sum_retiros,
          ROUND(COALESCE(SUM(ct.carga_total),0) / NULLIF(COUNT(*),0), 2)::float8 AS avg_cargas,
          ROUND(100.0 * COUNT(ct.uname) / NULLIF(COUNT(*),0),1)::float8 AS response_rate,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ct.has_carga) / NULLIF(COUNT(*),0),1)::float8 AS reload_rate
        FROM accounts a
        LEFT JOIN players cp ON cp.platform = a.platform AND cp.agente = a.agente AND cp.username_lower = a.uname
        LEFT JOIN firsts fp ON fp.platform = a.platform AND fp.agente = a.agente AND fp.username_lower = a.uname
        LEFT JOIN period_tx ct ON ct.platform = a.platform AND ct.agente = a.agente AND ct.uname = a.uname
        GROUP BY 1 ORDER BY total DESC
      ),
      vips AS (
        SELECT username_lower AS username, platform, agente, seg_monto, seg_actividad,
          ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - fecha_ultima)::int AS dias_ultimo,
          total_cargas::float8, cant_cargas, total_retiros::float8, cant_retiros, fecha_ultima::text
        FROM players
        WHERE ${filter} AND ${dashboardAgentSql(platform, 3)}
          AND seg_monto IN ${vipLevels} AND fecha_ultima IS NOT NULL
          AND seg_actividad IN ('inactivo','en_riesgo','perdido')
        ORDER BY CASE seg_actividad WHEN 'perdido' THEN 1 WHEN 'inactivo' THEN 2 WHEN 'en_riesgo' THEN 3 ELSE 4 END,
          fecha_ultima ASC, total_cargas DESC LIMIT 100
      ),
      activity_segments AS (SELECT seg_actividad AS seg, COUNT(*)::int AS cnt FROM players
        WHERE ${filter} AND ${dashboardAgentSql(platform, 3)} GROUP BY seg_actividad),
      value_segments AS (SELECT seg_monto AS seg, COUNT(*)::int AS cnt FROM players
        WHERE ${filter} AND ${dashboardAgentSql(platform, 3)} GROUP BY seg_monto)
      SELECT json_build_object(
        'summary', (SELECT row_to_json(s) FROM summary s),
        'agentes', COALESCE((SELECT json_agg(a) FROM agents a), '[]'::json),
        'vips', COALESCE((SELECT json_agg(v) FROM vips v), '[]'::json),
        'seg_actividad', COALESCE((SELECT json_agg(a) FROM activity_segments a), '[]'::json),
        'seg_monto', COALESCE((SELECT json_agg(v) FROM value_segments v), '[]'::json)
      ) AS dashboard
    `, [from, to, agent])
    return NextResponse.json(result[0].dashboard, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[/api/dashboard/casino GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron consultar las cuentas de casino' }, { status: 500 })
  }
}
