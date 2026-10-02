import { getLongRunningClient } from '@/lib/db'
import { contactMovementQuery } from '@/lib/contact-movement-query'
import { readInactivityRange } from '@/lib/contact-inactivity'
import { contactScope, type VisibilityRole } from '@/lib/contact-visibility'

const ACTIVITY = new Set(['nuevo', 'frecuente', 'regular', 'ocasional', 'en_riesgo', 'inactivo', 'perdido'])
const TENURE = new Set(['nuevo', 'reciente', 'establecido', 'veterano', 'leal'])
const PLATFORMS = new Set(['zeus', 'bet30', 'ganamos', 'argenbet', 'otros'])
const SEGMENTS = new Set(['casual', 'regular', 'whale', 'bajo', 'medio', 'vip', 'vip_medio', 'vip_alto', 'super_vip'])

export class ContactFilterError extends Error {}

/** One audience definition for list, count, selection and exports. */
export function contactFilters(sp: URLSearchParams, user: {
  role: VisibilityRole; user_id: string; allowed_agents?: string[] | null
}) {
  const params: unknown[] = []
  const where = ['TRUE']
  const bind = (value: unknown) => { params.push(value); return `$${params.length}` }
  const csv = (key: string, allowed: Set<string>) => {
    const values = [...new Set(sp.getAll(key).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean))]
    if (values.some(v => !allowed.has(v))) throw new ContactFilterError(`Filtro ${key} inválido`)
    return values
  }
  const q = sp.get('q')?.trim()
  if (q) {
    const p = bind(`%${q}%`)
    where.push(`(contacts.phone_number ILIKE ${p} OR contacts.first_name ILIKE ${p} OR contacts.last_name ILIKE ${p})`)
  }
  const segments = csv('segment', SEGMENTS)
  if (segments.length) where.push(`contacts.segment::text = ANY(${bind(segments)}::text[])`)
  for (const key of ['panel', 'gaming', 'linea', 'linea_sub'] as const) {
    const value = sp.get(key)?.trim()
    if (value) where.push(`contacts.${key}::text = ${bind(key === 'linea_sub' ? value.toLowerCase() : value)}`)
  }
  for (const [key, allowed] of [['actividad', ACTIVITY], ['antiguedad', TENURE]] as const) {
    const values = csv(key, allowed)
    if (values.length) where.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = contacts.id AND ct.tag = ANY(${bind(values.map(v => `casino:${key}:${v}`))}::text[]))`)
  }
  const list = sp.get('list_id')?.trim()
  if (list) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(list)) throw new ContactFilterError('Lista inválida')
    where.push(`EXISTS (SELECT 1 FROM contact_list_members lm WHERE lm.contact_id = contacts.id AND lm.list_id = ${bind(list)}::uuid)`)
  }
  const tag = sp.get('tag')?.trim().slice(0, 100)
  if (tag) where.push(`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = contacts.id AND ct.tag ILIKE '%' || ${bind(tag)} || '%' AND ct.tag NOT LIKE 'casino:%')`)
  const platform = sp.get('plataforma') || ''
  if (platform && !PLATFORMS.has(platform)) throw new ContactFilterError('Plataforma inválida')
  if (platform === 'otros') where.push(`NOT (COALESCE(contacts.platforms, '{}') && ARRAY['zeus','bet30','ganamos','argenbet'])`)
  else if (platform) where.push(`'${platform}' = ANY(contacts.platforms)`)
  if (sp.get('sin_movimiento') === 'true') where.push(`(contacts.last_deposit_at IS NULL OR contacts.last_deposit_at < NOW() - INTERVAL '12 months')`)
  const vis = contactScope(user, params.length)
  params.push(...vis.params)
  const sql = where.join('\n AND ') + ' AND ' + vis.sql
  return { sql, params }
}


/** Resolve movements once with indexed contact keys and a date-bounded history scan. */
export async function resolvedContactFilters(sp: URLSearchParams, user: Parameters<typeof contactFilters>[1]) {
  const audience = contactFilters(sp, user)
  let range
  try { range = readInactivityRange(sp) }
  catch (error) { throw new ContactFilterError((error as Error).message) }
  const movementDays = new Map<string, number>()
  if (range.min === '' && range.max === '') return { ...audience, movementDays, movementMode: range.mode }
  const platform = sp.get('plataforma') || ''
  const client = await getLongRunningClient()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'; SET LOCAL work_mem='32MB'; SET LOCAL enable_mergejoin=off")
    const movementQuery = contactMovementQuery(audience, range, platform)
    const { rows } = await client.query<{ contact_id: string; days_inactive: number }>(movementQuery.sql, movementQuery.params)
    for (const row of rows) movementDays.set(row.contact_id, Number(row.days_inactive))
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    await client.end()
  }
  audience.params.push([...movementDays.keys()])
  audience.sql += ` AND contacts.id = ANY($${audience.params.length}::uuid[])`
  return { ...audience, movementDays, movementMode: range.mode }
}
