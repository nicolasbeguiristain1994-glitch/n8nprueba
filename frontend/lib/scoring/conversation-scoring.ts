// Pure logic — no React. Fully testable in isolation.

// ── Types ──────────────────────────────────────────────────────────────────────

export type Segment = 'bajo' | 'medio' | 'alto' | 'vip' | null
export type Intent  = 'urgent' | 'complaint' | 'reactivation' | null
export type Filter  = 'all' | 'vip' | 'alto' | 'urgent' | 'complaint' | 'escalated' | 'unread'

export interface Conv {
  phone_number:       string
  last_message:       string
  last_direction:     string
  last_status:        string
  last_at:            string
  is_escalated?:      boolean
  escalation_reason?: string
  contact_id?:        string | null
  first_name?:        string | null
  last_name?:         string | null
  segment?:           Segment
  actividad?:         string | null
  valor_riesgo?:      string | null
  conv_flow?:         string | null
  is_blacklisted?:    boolean
  has_follow_up?:     boolean
}

export interface Message {
  id: string
  phone_number: string
  message_body: string
  direction: string
  status: string
  created_at: string
}

export interface ConvFilterDef {
  key:   Filter
  label: string
}

// ── Scoring weights (single source of truth — adjust here to reprioritize) ────

export const SCORING_WEIGHTS = {
  segment:  { vip: 100, alto: 70 } as const,
  intent:   { urgent: 60, complaint: 40, reactivation: 20 } as const,
  escalated: 40,
} as const

// ── Intent detection ───────────────────────────────────────────────────────────

const URGENT_KEYWORDS: readonly string[] = [
  'cargar', 'deposito', 'depósito', 'quiero cargar', 'quiero jugar',
  'bono', 'depositar', 'pasas para cargar', 'quiero depositar', 'cargas',
]
const COMPLAINT_KEYWORDS: readonly string[] = [
  'queja', 'problema', 'retiro', 'bloqueo', 'bloquearon',
  'no me pagan', 'no funciona', 'reclamo', 'mal servicio', 'me bloquearon',
]
const REACTIVATION_KEYWORDS: readonly string[] = [
  'volver', 'regres', 'hace tiempo', 'estoy de vuelta', 'extrañ', 'cuando vuelv',
]

export function detectIntent(message: string, direction: string): Intent {
  if (direction !== 'inbound') return null
  const lower = message.toLowerCase()
  if (URGENT_KEYWORDS.some(k    => lower.includes(k))) return 'urgent'
  if (COMPLAINT_KEYWORDS.some(k => lower.includes(k))) return 'complaint'
  if (REACTIVATION_KEYWORDS.some(k => lower.includes(k))) return 'reactivation'
  return null
}

// ── Priority score ─────────────────────────────────────────────────────────────

export function priorityScore(c: Conv): number {
  const w = SCORING_WEIGHTS
  let score = 0
  if (c.segment === 'vip')  score += w.segment.vip
  if (c.segment === 'alto') score += w.segment.alto
  const i = detectIntent(c.last_message, c.last_direction)
  if (i === 'urgent')       score += w.intent.urgent
  if (i === 'complaint')    score += w.intent.complaint
  if (c.is_escalated)       score += w.escalated
  if (i === 'reactivation') score += w.intent.reactivation
  return score
}

// ── Filters ────────────────────────────────────────────────────────────────────

export const FILTER_DEFS: ConvFilterDef[] = [
  { key: 'all',       label: 'Todos' },
  { key: 'vip',       label: 'VIP' },
  { key: 'alto',      label: 'Alto Valor' },
  { key: 'urgent',    label: 'Urgentes' },
  { key: 'complaint', label: 'Quejas' },
  { key: 'escalated', label: 'Escalados' },
  { key: 'unread',    label: 'Sin responder' },
]

export function applyFilter(convs: Conv[], filter: Filter): Conv[] {
  switch (filter) {
    case 'vip':       return convs.filter(c => c.segment === 'vip')
    case 'alto':      return convs.filter(c => c.segment === 'alto')
    case 'urgent':    return convs.filter(c => detectIntent(c.last_message, c.last_direction) === 'urgent')
    case 'complaint': return convs.filter(c => detectIntent(c.last_message, c.last_direction) === 'complaint' || !!c.is_escalated)
    case 'escalated': return convs.filter(c => !!c.is_escalated)
    case 'unread':    return convs.filter(c => c.last_direction === 'inbound')
    default:          return convs
  }
}

// ── Display utilities ──────────────────────────────────────────────────────────

export function fmtTime(iso: string): string {
  const d   = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
}

export function fmtPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 13 && digits.startsWith('549'))
    return `+54 9 ${digits.slice(3, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`
  if (digits.length === 12 && digits.startsWith('54'))
    return `+54 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`
  return `+${digits}`
}

export function displayName(c: Conv): string {
  if (c.first_name || c.last_name)
    return [c.first_name, c.last_name].filter(Boolean).join(' ')
  return fmtPhone(c.phone_number)
}

export function initials(c: Conv): string {
  if (c.first_name) return c.first_name[0].toUpperCase()
  if (c.last_name)  return c.last_name[0].toUpperCase()
  return c.phone_number.slice(-2)
}

export function avatarCls(segment: Segment | undefined): string {
  if (segment === 'vip')  return 'bg-yellow-100 text-yellow-700'
  if (segment === 'alto') return 'bg-green-100 text-green-700'
  return 'bg-gray-200 text-gray-600'
}
