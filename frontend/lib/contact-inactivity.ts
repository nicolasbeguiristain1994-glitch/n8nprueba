import { inactivityError, type InactivityRange } from './inactivity-range'

export function readInactivityRange(params: URLSearchParams): InactivityRange {
  const mode = params.get('movimiento_modo')
  if (mode && mode !== 'periodo') throw new Error('Modo de movimientos inválido.')
  const range: InactivityRange = {
    ...(mode === 'periodo' ? { mode: 'period' as const } : {}),
    min: params.get('inactividad_desde') ?? params.get('inactividad_dias') ?? '',
    max: params.get('inactividad_hasta') ?? '',
  }
  const error = inactivityError(range)
  if (error) throw new Error(error)
  return range
}

// Resolve the expensive account/history join once per request, then reuse IDs
// for the visible page and its total without caching stale financial activity.
export function inactivityIdsFilter(ids: string[] | null, offset: number) {
  return ids === null
    ? { cte: '', sql: '', params: [] as unknown[] }
    : { cte: '', sql: ` AND contacts.id = ANY($${offset + 1}::uuid[])`, params: [ids] as unknown[] }
}

// Last-movement mode applies age bounds AFTER taking the full-history MAX.
// Period mode filters individual movements BEFORE the MAX, so more recent
// activity never disqualifies a contact who also moved inside the period.
export function contactInactivity(range: InactivityRange, platform: string, offset: number) {
  if (range.min === '' && range.max === '') return { cte: '', sql: '', params: [] as unknown[] }
  const params: unknown[] = [platform]
  const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date"
  const period = range.mode === 'period'
  const date = period ? 'fecha' : 'last_movement'
  const predicates = [`${date} <= ${today}`]
  if (range.min !== '') { params.push(Number(range.min)); predicates.push(`${today} - ${date} > $${offset + params.length}::int`) }
  if (range.max !== '') { params.push(Number(range.max)); predicates.push(`${today} - ${date} <= $${offset + params.length}::int`) }
  return {
    cte: `WITH inactivity_movements AS MATERIALIZED (
      SELECT platform, lower(username) username_lower, max(fecha) last_movement
      FROM casino_transactions
      WHERE tipo IN ('carga','retiro') AND platform IN ('zeus','bet30','ganamos','argenbet')
        AND ($${offset + 1}::text='' OR platform=$${offset + 1}::text)
        ${period ? `AND ${predicates.join(' AND ')}` : ''}
      GROUP BY platform, lower(username)
    ), inactivity_contacts AS MATERIALIZED (
      SELECT l.contact_id, max(d.last_movement) last_movement
      FROM casino_contact_account_links l
      JOIN inactivity_movements d USING(platform,username_lower)
      GROUP BY l.contact_id
    )`,
    sql: ` AND contacts.id IN (SELECT contact_id FROM inactivity_contacts WHERE ${period ? 'TRUE' : predicates.join(' AND ')})`,
    params,
  }
}
