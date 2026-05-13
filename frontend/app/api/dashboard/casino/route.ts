import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getAgentsSqlArray, getCanonicalAgenteExpr, isValidPlatform } from '@/lib/casino-agents'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CasinoSummary {
  nuevos_mes:              number  // fecha_primera >= hoy - 30
  activos_mes:             number  // fecha_ultima  >= hoy - 30
  nuevos_anterior:         number  // fecha_primera en días 31-60 atrás
  activos_anterior:        number  // fecha_ultima  en días 31-60 atrás
  total_vip:               number  // seg_monto = 'vip'
  prioridad_reactivacion:  number  // vip/alto + inactivo/en_riesgo/perdido
  total_jugadores:         number
}

export interface CasinoAgente {
  agente:        string
  total:         number
  nuevos_mes:    number
  activos_mes:   number
  vip:           number
  en_riesgo:     number   // inactivo + en_riesgo + perdido
  sum_cargas:    number   // Σ cargas acumuladas históricas del agente
  sum_retiros:   number   // Σ retiros acumulados históricos del agente
  avg_cargas:    number   // promedio de cargas por jugador
  response_rate: number   // % jugadores con actividad en el período (activos_mes / total)
  reload_rate:   number   // % jugadores con al menos 1 depósito en el período
}

export interface CasinoVip {
  username:      string
  agente:        string
  seg_monto:     string  // 'vip' | 'alto'
  seg_actividad: string
  dias_ultimo:   number  // CURRENT_DATE - fecha_ultima
  total_cargas:  number
  cant_cargas:   number
  total_retiros: number
  cant_retiros:  number
  fecha_ultima:  string
}

export interface SegCount { seg: string; cnt: number }

// ── GET /api/dashboard/casino ─────────────────────────────────────────────────
// "Último mes" = trailing 30 days from today.
// "Período anterior" = días 31–60 atrás (equal-length comparison window).
// dias_ultimo: computed live as CURRENT_DATE - fecha_ultima — always current.

export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const url          = new URL(req.url)
  const platformParam = url.searchParams.get('platform')?.trim() || 'zeus'
  if (!isValidPlatform(platformParam)) {
    return NextResponse.json(
      { error: `Plataforma inválida: "${platformParam}"` },
      { status: 400 },
    )
  }

  // Date range for nuevos_mes / activos_mes — defaults to trailing 30 days
  function isoToday() { return new Date().toISOString().slice(0, 10) }
  function iso30dAgo() {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10)
  }
  const fromParam  = url.searchParams.get('from')?.trim()  || iso30dAgo()
  const toParam    = url.searchParams.get('to')?.trim()    || isoToday()
  // Optional single-agent filter (for widget-level filtering; empty = all agents)
  const agentParam = url.searchParams.get('agent')?.trim() || null

  const agentsSql     = getAgentsSqlArray(platformParam)
  const isConsolidado = platformParam === 'consolidado'
  const agenteExpr    = isConsolidado ? getCanonicalAgenteExpr('cp.agente') : 'cp.agente'
  // Extra WHERE clause and query params when a specific agent is requested
  const agentClause  = agentParam ? 'AND cp.agente = $3' : ''
  const agentParams  = agentParam ? [fromParam, toParam, agentParam] : [fromParam, toParam]

  try {
    const [summary, agentes, vips, segActividad, segMonto] = await Promise.all([

      // ── Resumen global ──────────────────────────────────────────────────────
      query<CasinoSummary>(`
        SELECT
          COUNT(*) FILTER (
            WHERE fecha_primera >= CURRENT_DATE - 30
          )::int                                                        AS nuevos_mes,
          COUNT(*) FILTER (
            WHERE fecha_ultima  >= CURRENT_DATE - 30
          )::int                                                        AS activos_mes,
          COUNT(*) FILTER (
            WHERE fecha_primera BETWEEN CURRENT_DATE - 60
                                    AND CURRENT_DATE - 31
          )::int                                                        AS nuevos_anterior,
          COUNT(*) FILTER (
            WHERE fecha_ultima  BETWEEN CURRENT_DATE - 60
                                    AND CURRENT_DATE - 31
          )::int                                                        AS activos_anterior,
          COUNT(*) FILTER (WHERE seg_monto = 'vip')::int               AS total_vip,
          COUNT(*) FILTER (
            WHERE seg_monto    IN ('vip','alto')
              AND seg_actividad IN ('inactivo','en_riesgo','perdido')
          )::int                                                        AS prioridad_reactivacion,
          COUNT(*)::int                                                 AS total_jugadores
        FROM casino_players
        WHERE agente = ANY(${agentsSql})
      `),

      // ── Por agente ──────────────────────────────────────────────────────────
      // nuevos_mes / activos_mes respetan el rango from/to del request.
      // Los totales (sum_cargas, sum_retiros, avg_cargas) son siempre históricos.
      // reload_rate: % jugadores con ≥1 carga en el período (via casino_transactions).
      // response_rate: % jugadores activos en el período (activos_mes / total).
      // agentParam (opcional) filtra a un único agente.
      query<CasinoAgente>(`
        SELECT
          ${agenteExpr}                                                              AS agente,
          COUNT(*)::int                                                              AS total,
          COUNT(*) FILTER (WHERE cp.fecha_primera BETWEEN $1::date AND $2::date)::int AS nuevos_mes,
          COUNT(*) FILTER (WHERE cp.fecha_ultima  BETWEEN $1::date AND $2::date)::int AS activos_mes,
          COUNT(*) FILTER (WHERE cp.seg_monto = 'vip')::int                         AS vip,
          COUNT(*) FILTER (
            WHERE cp.seg_actividad IN ('inactivo','en_riesgo','perdido')
          )::int                                                                     AS en_riesgo,
          COALESCE(SUM(cp.total_cargas),  0)::bigint                                AS sum_cargas,
          COALESCE(SUM(cp.total_retiros), 0)::bigint                                AS sum_retiros,
          ROUND(COALESCE(AVG(cp.total_cargas), 0))::bigint                          AS avg_cargas,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE cp.fecha_ultima BETWEEN $1::date AND $2::date)
            / NULLIF(COUNT(*), 0), 1
          )::numeric                                                                 AS response_rate,
          ROUND(
            100.0 * COUNT(reloaded.uname) / NULLIF(COUNT(*), 0), 1
          )::numeric                                                                 AS reload_rate
        FROM casino_players cp
        LEFT JOIN (
          SELECT agente, LOWER(username) AS uname
          FROM casino_transactions
          WHERE fecha BETWEEN $1::date AND $2::date
            AND tipo = 'carga'
          GROUP BY agente, LOWER(username)
        ) reloaded ON reloaded.uname = cp.username_lower
                  AND reloaded.agente = cp.agente
        WHERE cp.agente = ANY(${agentsSql})
          ${agentClause}
        GROUP BY 1
        ORDER BY total DESC
      `, agentParams),

      // ── VIP / Alto — seguimiento urgencia ───────────────────────────────────
      // Ordenado: perdido → inactivo → en_riesgo → resto; luego días sin movimiento DESC,
      // luego gasto total DESC.  Limitado a 100 filas.
      query<CasinoVip>(`
        SELECT
          username,
          agente,
          seg_monto,
          seg_actividad,
          (CURRENT_DATE - fecha_ultima)::int  AS dias_ultimo,
          total_cargas,
          cant_cargas,
          total_retiros,
          cant_retiros,
          fecha_ultima::text                  AS fecha_ultima
        FROM casino_players
        WHERE seg_monto IN ('vip','alto')
          AND fecha_ultima IS NOT NULL
          AND agente = ANY(${agentsSql})
        ORDER BY
          CASE seg_actividad
            WHEN 'perdido'    THEN 1
            WHEN 'inactivo'   THEN 2
            WHEN 'en_riesgo'  THEN 3
            WHEN 'ocasional'  THEN 4
            ELSE                   5
          END ASC,
          (CURRENT_DATE - fecha_ultima) DESC,
          total_cargas DESC
        LIMIT 100
      `),

      query<{ seg: string; cnt: number }>(`
        SELECT seg_actividad AS seg, COUNT(*)::int AS cnt
        FROM casino_players
        WHERE agente = ANY(${agentsSql})
        GROUP BY seg_actividad
      `),

      query<{ seg: string; cnt: number }>(`
        SELECT seg_monto AS seg, COUNT(*)::int AS cnt
        FROM casino_players
        WHERE agente = ANY(${agentsSql})
        GROUP BY seg_monto
      `),
    ])

    return NextResponse.json({
      summary:       summary[0] ?? null,
      agentes,
      vips,
      seg_actividad: segActividad,
      seg_monto:     segMonto,
    })
  } catch (e) {
    console.error('[/api/dashboard/casino GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
