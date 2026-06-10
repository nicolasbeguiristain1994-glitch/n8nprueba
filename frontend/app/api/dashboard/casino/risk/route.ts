import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getAgentsSqlArray, isValidPlatform } from '@/lib/casino-agents'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RiskSummary {
  nuevos_extractores: number   // new players (<90d) withdrawing >60% of deposits
  jugadores_deficit:  number   // players where casino has net loss
  perdida_bruta:      number   // total casino net loss across deficit players
  vip_recuperables:   number   // vip+ in 'en_riesgo' (still saveable)
}

export interface NuevoExtractor {
  username:           string
  agente:             string
  seg_monto:          string
  total_cargas:       number
  total_retiros:      number
  ratio_retiro_pct:   number   // (retiros / cargas) * 100
  dias_desde_ingreso: number
  cant_cargas:        number
  cant_retiros:       number
}

export interface DeficitJugador {
  username:      string
  agente:        string
  seg_monto:     string
  seg_actividad: string
  total_cargas:  number
  total_retiros: number
  deficit:       number   // retiros − cargas (always positive here)
  fecha_ultima:  string | null
}

export interface VipRecuperable {
  username:     string
  agente:       string
  seg_monto:    string
  total_cargas: number
  total_retiros: number
  dias_ultimo:  number
  fecha_ultima: string | null
}

// ── GET /api/dashboard/casino/risk ───────────────────────────────────────────
// Optional query param: agente — filter all tables by agent.
//
// Indicators:
//   1. Nuevos extractores  — joined <90d, withdrew >60% of deposits
//   2. Déficit del casino  — players where total_retiros > total_cargas
//   3. VIP recuperables    — vip/alto players still in en_riesgo (not yet lost)

export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const url           = new URL(req.url)
  const agenteParam   = url.searchParams.get('agente')?.trim() || null
  const platformParam = url.searchParams.get('platform')?.trim() || 'zeus'

  if (!isValidPlatform(platformParam)) {
    return NextResponse.json(
      { error: `Plataforma inválida: "${platformParam}"` },
      { status: 400 },
    )
  }
  const agentsSql = getAgentsSqlArray(platformParam)

  try {
    const [summaryRows, extractores, deficit, recuperables] = await Promise.all([

      // ── Resumen de riesgo ─────────────────────────────────────────────────
      query<RiskSummary>(`
        SELECT
          COUNT(*) FILTER (
            WHERE fecha_primera >= CURRENT_DATE - 90
              AND total_cargas  > 0
              AND cant_retiros  > 0
              AND total_retiros::numeric / total_cargas > 0.6
              AND ($1::text IS NULL OR agente = $1)
          )::int AS nuevos_extractores,

          COUNT(*) FILTER (
            WHERE total_cargas  > 0
              AND total_retiros > total_cargas
              AND ($1::text IS NULL OR agente = $1)
          )::int AS jugadores_deficit,

          COALESCE(SUM(
            CASE WHEN total_retiros > total_cargas AND ($1::text IS NULL OR agente = $1)
              THEN total_retiros - total_cargas ELSE 0 END
          ), 0)::bigint AS perdida_bruta,

          COUNT(*) FILTER (
            WHERE seg_monto    IN ('super_vip','vip_alto','vip_medio','vip')
              AND seg_actividad = 'en_riesgo'
              AND ($1::text IS NULL OR agente = $1)
          )::int AS vip_recuperables

        FROM casino_players
        WHERE agente = ANY(${agentsSql})
      `, [agenteParam]),

      // ── Nuevos extractores ────────────────────────────────────────────────
      // Players who joined in the last 90 days and have already withdrawn
      // more than 60% of what they deposited — likely bonus hunters.
      query<NuevoExtractor>(`
        SELECT
          username,
          agente,
          COALESCE(seg_monto, '') AS seg_monto,
          total_cargas::bigint,
          total_retiros::bigint,
          ROUND(total_retiros::numeric / NULLIF(total_cargas,0) * 100, 1) AS ratio_retiro_pct,
          (CURRENT_DATE - fecha_primera)::int AS dias_desde_ingreso,
          cant_cargas,
          cant_retiros
        FROM casino_players
        WHERE fecha_primera >= CURRENT_DATE - 90
          AND total_cargas  > 0
          AND cant_retiros  > 0
          AND total_retiros::numeric / total_cargas > 0.6
          AND agente = ANY(${agentsSql})
          AND ($1::text IS NULL OR agente = $1)
        ORDER BY (total_retiros::numeric / total_cargas) DESC, total_retiros DESC
        LIMIT 100
      `, [agenteParam]),

      // ── Déficit del casino ────────────────────────────────────────────────
      // Players where the casino has paid out more than it received.
      query<DeficitJugador>(`
        SELECT
          username,
          agente,
          COALESCE(seg_monto,     '') AS seg_monto,
          COALESCE(seg_actividad, '') AS seg_actividad,
          total_cargas::bigint,
          total_retiros::bigint,
          (total_retiros - total_cargas)::bigint AS deficit,
          fecha_ultima::text
        FROM casino_players
        WHERE total_cargas  > 0
          AND total_retiros > total_cargas
          AND agente = ANY(${agentsSql})
          AND ($1::text IS NULL OR agente = $1)
        ORDER BY (total_retiros - total_cargas) DESC
        LIMIT 100
      `, [agenteParam]),

      // ── VIP / Oro recuperables ────────────────────────────────────────────
      // High-value players in en_riesgo (not yet inactivo/perdido) —
      // still reachable, highest ROI for reactivation campaigns.
      query<VipRecuperable>(`
        SELECT
          username,
          agente,
          COALESCE(seg_monto, '') AS seg_monto,
          total_cargas::bigint,
          total_retiros::bigint,
          (CURRENT_DATE - fecha_ultima)::int AS dias_ultimo,
          fecha_ultima::text
        FROM casino_players
        WHERE seg_monto    IN ('super_vip','vip_alto','vip_medio','vip')
          AND seg_actividad = 'en_riesgo'
          AND fecha_ultima IS NOT NULL
          AND agente = ANY(${agentsSql})
          AND ($1::text IS NULL OR agente = $1)
        ORDER BY (CURRENT_DATE - fecha_ultima) ASC, total_cargas DESC
        LIMIT 50
      `, [agenteParam]),
    ])

    return NextResponse.json({
      summary:       summaryRows[0] ?? null,
      extractores,
      deficit,
      recuperables,
    })
  } catch (e) {
    console.error('[/api/dashboard/casino/risk GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
