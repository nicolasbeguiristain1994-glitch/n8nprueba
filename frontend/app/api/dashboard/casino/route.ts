import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getAgentsSqlArray, isValidPlatform } from '@/lib/casino-agents'

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
  agente:      string
  total:       number
  nuevos_mes:  number
  activos_mes: number
  vip:         number
  en_riesgo:   number   // inactivo + en_riesgo + perdido
  sum_cargas:  number   // Σ cargas acumuladas históricas del agente
  sum_retiros: number   // Σ retiros acumulados históricos del agente
  avg_cargas:  number   // promedio de cargas por jugador
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
  const agentsSql = getAgentsSqlArray(platformParam)

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
      query<CasinoAgente>(`
        SELECT
          agente,
          COUNT(*)::int                                                              AS total,
          COUNT(*) FILTER (WHERE fecha_primera >= CURRENT_DATE - 30)::int           AS nuevos_mes,
          COUNT(*) FILTER (WHERE fecha_ultima  >= CURRENT_DATE - 30)::int           AS activos_mes,
          COUNT(*) FILTER (WHERE seg_monto = 'vip')::int                            AS vip,
          COUNT(*) FILTER (
            WHERE seg_actividad IN ('inactivo','en_riesgo','perdido')
          )::int                                                                     AS en_riesgo,
          COALESCE(SUM(total_cargas),  0)::bigint                                   AS sum_cargas,
          COALESCE(SUM(total_retiros), 0)::bigint                                   AS sum_retiros,
          ROUND(COALESCE(AVG(total_cargas), 0))::bigint                             AS avg_cargas
        FROM casino_players
        WHERE agente = ANY(${agentsSql})
        GROUP BY agente
        ORDER BY total DESC
      `),

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
