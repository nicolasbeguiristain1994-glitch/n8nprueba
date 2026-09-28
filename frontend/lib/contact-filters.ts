import { visibilityClause, type VisibilityRole } from '@/lib/contact-visibility'

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
  const where = ['contacts.deleted_at IS NULL']
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
  const days = sp.get('inactividad_dias')
  if (days) {
    if (!/^\d+$/.test(days) || !Number.isSafeInteger(Number(days)) || Number(days) > 36500) throw new ContactFilterError('Días de inactividad inválidos')
    if (Number(days) > 0) where.push(`contacts.last_deposit_at < NOW() - ${bind(Number(days))}::int * INTERVAL '1 day'`)
  }
  const vis = visibilityClause(user.role, user.user_id, params.length)
  params.push(...vis.params)
  let sql = where.join('\n AND ') + vis.sql
  if (user.role !== 'admin' && user.allowed_agents?.length) sql += ` AND contacts.panel = ANY(${bind(user.allowed_agents)}::text[])`
  return { sql, params }
}
