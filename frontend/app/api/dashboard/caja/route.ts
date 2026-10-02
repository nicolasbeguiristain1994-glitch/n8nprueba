import { financialLedgerSql } from '@/lib/dashboard-financial-ledger'
import { dashboardAgent, dashboardAgentSql, movementPeriodSql } from '@/lib/dashboard-scope'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getPlatformFilterSql, isValidPlatform } from '@/lib/casino-agents'
import { argentinaToday, validDateRange } from '@/lib/dashboard-format'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CajaRow {
  id:             string
  id_rec:         string | null
  fecha:          string         // DATE as text (YYYY-MM-DD)
  fecha_hora_utc: string | null  // full ISO timestamp when available
  platform:       string | null  // identidad compuesta (platform, username) — D2
  agente:         string
  username:       string
  tipo:           'carga' | 'retiro' | 'bono'
  monto:          string
  raw_detalles:   string | null
}

export interface CajaTotals {
  depositos:          string
  retiros:            string
  deposito_bonificado: string | null
  saldo:              string
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
  const requestedPlatform = url.searchParams.get('platform')?.trim() || 'consolidado'
  const platform = requestedPlatform === 'all' ? 'consolidado' : requestedPlatform === 'royal' ? 'bet30' : requestedPlatform
  const from     = url.searchParams.get('from')?.trim()     || argentinaToday()
  const to       = url.searchParams.get('to')?.trim()       || argentinaToday()
  const search   = url.searchParams.get('search')?.trim()   || ''
  const searchBy = url.searchParams.get('search_by')?.trim() || 'username'
  const page     = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const perPage  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '20', 10)))
  const offset   = (page - 1) * perPage

  if (!isValidPlatform(platform) || !validDateRange(from, to) || !Number.isSafeInteger(page) || !Number.isSafeInteger(perPage) || !Number.isSafeInteger(offset)) {
    return NextResponse.json({ error: 'Plataforma, fechas o paginación inválidas' }, { status: 400 })
  }
  const baseParams: (string | number)[] = [from, to]
  const agent = dashboardAgent(platform, url.searchParams.get('agent') || '')
  const agentIndex = agent ? baseParams.push(agent) : 0
  const searchIndex = search ? baseParams.push(`%${search.toLowerCase()}%`) : 0
  const scope = (alias: string) => `${movementPeriodSql(alias)} AND ${getPlatformFilterSql(platform, alias)}
    ${agentIndex ? `AND ${dashboardAgentSql(platform, agentIndex, alias)}` : ''}
    ${searchIndex ? `AND LOWER(${alias}.${searchBy === 'agente' ? 'agente' : 'username'}) LIKE $${searchIndex}` : ''}`
  const pIdx = baseParams.length

  try {
    // One bounded ledger and one database snapshot for rows, count and totals.
    // Previously each request scanned the entire history three times in parallel.
    const [result] = await query<{
      rows: CajaRow[]; total: number; depositos: string; retiros: string;
      deposito_bonificado: string; saldo: string
    }>(`
      WITH ledger AS MATERIALIZED (${financialLedgerSql(scope)}), paged AS (
        SELECT id::text, id_rec::text, fecha::text AS fecha, fecha_hora_utc,
          platform, agente, username, tipo, monto::text, raw_detalles
        FROM ledger
        ORDER BY fecha DESC, fecha_hora_utc DESC NULLS LAST,
          CASE WHEN ledger.id ~ '^[0-9]+$' THEN ledger.id::numeric END DESC NULLS LAST, ledger.id DESC
        LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}
      )
      SELECT COUNT(*)::int AS total,
        COALESCE(SUM(monto) FILTER (WHERE tipo='carga'),0)::text AS depositos,
        COALESCE(SUM(monto) FILTER (WHERE tipo='retiro'),0)::text AS retiros,
        COALESCE(SUM(monto) FILTER (WHERE tipo='bono'),0)::text AS deposito_bonificado,
        COALESCE(SUM(CASE WHEN tipo IN ('carga','bono') THEN monto WHEN tipo='retiro' THEN -monto ELSE 0 END),0)::text AS saldo,
        COALESCE((SELECT json_agg(p) FROM paged p),'[]'::json) AS rows
      FROM ledger
    `, [...baseParams, perPage, offset])
    const { depositos, retiros, saldo, deposito_bonificado } = result
    // JSON aggregation returns timestamp strings instead of pg Date instances.
    // Preserve the existing public ISO format and millisecond precision.
    const rowsRes = result.rows.map(row => ({ ...row,
      fecha_hora_utc: row.fecha_hora_utc ? new Date(row.fecha_hora_utc).toISOString() : null,
    }))

    return NextResponse.json({
      rows:     rowsRes,
      total:    result.total,
      page,
      per_page: perPage,
      totals: {
        depositos,
        retiros,
        deposito_bonificado,
        saldo,
      },
    } satisfies CajaResponse)
  } catch (e) {
    console.error('[/api/dashboard/caja GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
