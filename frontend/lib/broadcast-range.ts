export type BroadcastRange = { mode: '' | 'sent' | 'not_sent'; period: 'days' | 'dates'; days: string; from: string; to: string }
export const EMPTY_BROADCAST: BroadcastRange = { mode: '', period: 'days', days: '7', from: '', to: '' }
const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0,4)) >= 1900 && Number(v.slice(0,4)) <= 9998 && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v
export function broadcastError(v: BroadcastRange): string | null {
  if (!v.mode) return null
  if (!['sent','not_sent'].includes(v.mode)) return 'Filtro de difusión inválido'
  if (v.period === 'days') return /^[1-9]\d*$/.test(v.days) && Number(v.days) <= 36500 ? null : 'Ingresá entre 1 y 36500 días completos'
  if (v.period !== 'dates' || !validDate(v.from) || !validDate(v.to)) return 'Elegí las dos fechas del período'
  return v.from <= v.to ? null : 'La fecha desde no puede ser posterior a hasta'
}
export function broadcastParams(v: BroadcastRange): Record<string,string> {
  if (!v.mode) return {}
  return { difusion: v.mode, ...(v.period === 'days' ? { difusion_dias: v.days } : { difusion_desde: v.from, difusion_hasta: v.to }) }
}
export function readBroadcastRange(sp: URLSearchParams): BroadcastRange {
  const mode = sp.get('difusion') || ''
  const days = sp.get('difusion_dias') || ''
  const from = sp.get('difusion_desde') || '', to = sp.get('difusion_hasta') || ''
  if ((!mode && (days || from || to)) || (days && (from || to))) throw new Error('Filtro de difusión incompatible')
  const v = { mode, period: days ? 'days' : 'dates', days, from, to } as BroadcastRange
  const error = broadcastError(v)
  if (error) throw new Error(error)
  return v
}
export function broadcastLabel(v: BroadcastRange): string {
  if (!v.mode) return 'Difusión'
  const what = v.mode === 'sent' ? 'Difundidos' : 'No difundidos'
  const date = (s: string) => s.split('-').reverse().join('/')
  return v.period === 'days' ? `${what}: últimos ${v.days} días` : `${what}: ${date(v.from)} – ${date(v.to)}`
}
