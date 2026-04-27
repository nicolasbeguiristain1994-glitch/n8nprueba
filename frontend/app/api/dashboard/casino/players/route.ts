import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CasinoJugador {
  username:      string
  agente:        string
  seg_monto:     string
  seg_actividad: string
  total_cargas:  number
  cant_cargas:   number
  total_retiros: number
  cant_retiros:  number
  neto:          number
  dias_ultimo:   number | null
  fecha_ultima:  string | null
}

// ── GET /api/dashboard/casino/players ────────────────────────────────────────
// Query params:
//   agente  — filter by agent name (optional)
//   dias    — only players with fecha_ultima >= CURRENT_DATE - dias (optional)
// Returns up to 500 rows ordered by total_cargas DESC.

export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const url         = new URL(req.url)
  const agenteParam = url.searchParams.get('agente') || null
  const diasParam   = parseInt(url.searchParams.get('dias') || '') || null

  try {
    const rows = await query<CasinoJugador>(`
      SELECT
        username,
        agente,
        COALESCE(seg_monto,     '') AS seg_monto,
        COALESCE(seg_actividad, '') AS seg_actividad,
        total_cargas::bigint        AS total_cargas,
        cant_cargas,
        total_retiros::bigint       AS total_retiros,
        cant_retiros,
        (total_cargas - total_retiros)::bigint AS neto,
        CASE WHEN fecha_ultima IS NOT NULL
          THEN (CURRENT_DATE - fecha_ultima)::int
        END                         AS dias_ultimo,
        fecha_ultima::text
      FROM casino_players
      WHERE agente IS NOT NULL
        AND ($1::text IS NULL OR agente = $1)
        AND ($2::int  IS NULL OR fecha_ultima >= CURRENT_DATE - $2)
      ORDER BY total_cargas DESC
      LIMIT 500
    `, [agenteParam, diasParam])

    return NextResponse.json({ jugadores: rows })
  } catch (e) {
    console.error('[/api/dashboard/casino/players GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
