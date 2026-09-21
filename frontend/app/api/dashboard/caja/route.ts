import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { SYNC_PLATFORMS } from '@/lib/casino-agents'

// ── Platform filter ──────────────────────────────────────────────────────────
// "zeus"  = zeus platform
// "royal" = bet30 platform (called Royal internally, historical UI naming)
// "all"   = every platform (H3 fix: was ANY(agent-list) — mixed platforms
//   whenever an agent name is shared, e.g. 'bigwin' in zeus and bet30. Now
//   filters strictly by the `platform` column, same as /api/dashboard/casino.)

function platformFilterSql(platform: string): string {
  if (platform === 'zeus')  return `platform = 'zeus'`
  if (platform === 'royal') return `platform = 'bet30'`
  return `platform = ANY('{${SYNC_PLATFORMS.join(',')}}'::text[])`
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CajaRow {
  id:             number
  id_rec:         number | null
  fecha:          string         // DATE as text (YYYY-MM-DD)
  fecha_hora_utc: string | null  // full ISO timestamp when available
  platform:       string | null  // identidad compuesta (platform, username) — D2
  agente:         string
  username:       string
  tipo:           'carga' | 'retiro'
  monto:          number
  raw_detalles:   string | null
}

export interface CajaTotals {
  depositos:          number
  retiros:            number
  deposito_bonificado: number   // always 0 — not tracked in current schema
  saldo:              number
}

export interface CajaResponse {
  rows:     CajaRow[]
  total:    number
  page:     number
  per_page: number
  totals:   CajaTotals
}

// ── GET /api/dashboard/caja ───────────────────────────────────────────────────

export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const url      = new URL(req.url)
  const platform = url.searchParams.get('platform')?.trim() || 'all'
  const from     = url.searchParams.get('from')?.trim()     || new Date().toISOString().slice(0, 10)
  const to       = url.searchParams.get('to')?.trim()       || new Date().toISOString().slice(0, 10)
  const search   = url.searchParams.get('search')?.trim()   || ''
  const searchBy = url.searchParams.get('search_by')?.trim() || 'username'
  const page     = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const perPage  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '20', 10)))
  const offset   = (page - 1) * perPage

  const platformFilter = platformFilterSql(platform)

  // Build optional search clause
  const baseParams: (string | number)[] = [from, to]
  let searchClause = ''
  if (search) {
    baseParams.push(`%${search.toLowerCase()}%`)
    const col = searchBy === 'agente' ? 'agente' : 'username'
    searchClause = `AND LOWER(${col}) LIKE $3`
  }

  // Params for data query (adds LIMIT and OFFSET)
  const pIdx    = baseParams.length
  const dataParams = [...baseParams, perPage, offset]

  try {
    const [countRes, rowsRes, totalsRes] = await Promise.all([

      // ── Total count (for pagination) ────────────────────────────────────────
      query<{ total: number }>(`
        SELECT COUNT(*)::int AS total
        FROM casino_transactions
        WHERE fecha BETWEEN $1::date AND $2::date
          AND ${platformFilter}
          ${searchClause}
      `, baseParams),

      // ── Page of rows ────────────────────────────────────────────────────────
      query<CajaRow>(`
        SELECT
          id,
          id_rec,
          fecha::text                     AS fecha,
          fecha_hora_utc,
          platform,
          agente,
          username,
          tipo,
          monto,
          raw_detalles
        FROM casino_transactions
        WHERE fecha BETWEEN $1::date AND $2::date
          AND ${platformFilter}
          ${searchClause}
        ORDER BY fecha_hora_utc DESC NULLS LAST, id DESC
        LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}
      `, dataParams),

      // ── Aggregate totals for the whole filtered set ─────────────────────────
      query<{ depositos: number; retiros: number }>(`
        SELECT
          COALESCE(SUM(CASE WHEN tipo = 'carga'  THEN monto ELSE 0 END), 0)::float8 AS depositos,
          COALESCE(SUM(CASE WHEN tipo = 'retiro' THEN monto ELSE 0 END), 0)::float8 AS retiros
        FROM casino_transactions
        WHERE fecha BETWEEN $1::date AND $2::date
          AND ${platformFilter}
          ${searchClause}
      `, baseParams),
    ])

    const { depositos, retiros } = totalsRes[0] ?? { depositos: 0, retiros: 0 }

    return NextResponse.json({
      rows:     rowsRes,
      total:    countRes[0]?.total ?? 0,
      page,
      per_page: perPage,
      totals: {
        depositos,
        retiros,
        deposito_bonificado: 0,
        saldo: depositos - retiros,
      },
    } satisfies CajaResponse)
  } catch (e) {
    console.error('[/api/dashboard/caja GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
