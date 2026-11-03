import { calculateRiskScore, type ScorerConfig } from './contact-frequency/risk-scorer'
import type { ContactFrequencyRule } from './contact-frequency/types'
import { checkEligibility, type EligibilityConfig } from './user-prioritization/prioritization-rules'
import type { ValueTier } from './user-prioritization/config'

export interface BroadcastPlanFilters {
  platform?: string
  agent?: string
  valueTier?: ValueTier
  reactivationSegment?: string
}

export interface BroadcastPlanOptions extends BroadcastPlanFilters {
  lineIds: string[]
  messageType: 'template' | 'text'
  templateId?: string
  endTime: string
  reservePercent: number
  maxContacts: number
}

export interface PlanningLine {
  id: string
  name: string
  type: 'cloud' | 'evolution'
  status: string
  connected: boolean
  enabled: boolean
  campaignAllowed: boolean
  dailyLimit: number
  hourlyLimit: number
  sentToday: number
  sentHour: number
  dayResetAt: string | null
  hourResetAt: string | null
  priority: number
  committed: number
  wabaId: string | null
  cloudReady: boolean
  activeHours: [number, number] | null
  timezoneOffset: number
  invalidSchedule: boolean
  recommendedRemaining?: number
  recommendation?: string
  volumeBlocked?: boolean
}

export interface PlanningContact {
  id: string
  name: string
  phone: string
  score: number
  segment: string | null
  tier: ValueTier
  agent: string | null
  status: string
  optedIn: boolean
  doNotContact: boolean
  deleted: boolean
  blacklisted: boolean
  lastDepositAt: string | null
  computedAt: string
  lastSentAt: string | null
  sentToday: number
  sentWeek: number
  alreadyQueued: boolean
  hasAssignment: boolean
  assignedLineId: string | null
}

export const PLAN_REASON_LABELS = {
  invalid_phone: 'Teléfono inválido',
  duplicate: 'Teléfono duplicado',
  excluded: 'Baja, bloqueo o falta de consentimiento',
  inactive_status: 'Estado no habilitado para campañas',
  activity_changed: 'Actividad posterior al cálculo de prioridades',
  no_longer_eligible: 'Fuera de la ventana o del intervalo de recontacto',
  frequency: 'Límite de frecuencia de contacto',
  already_queued: 'Ya incluido en otra campaña pendiente',
  assigned_line_unavailable: 'Línea habitual no disponible o no seleccionada',
  assigned_line_full: 'Sin cupo en su línea habitual',
  no_capacity: 'Sin cupo en las líneas seleccionadas',
  selection_limit: 'Máximo de contactos del plan alcanzado',
} as const
export type PlanReason = keyof typeof PLAN_REASON_LABELS

export interface PlannedContact {
  id: string; name: string; phone: string; score: number
  segment: string | null; tier: ValueTier; agent: string | null
  lineId: string | null; reason: PlanReason | null
}

export interface PlannedLine {
  id: string; name: string; type: string
  dailyLimit: number; hourlyLimit: number; used: number; committed: number
  recommendedRemaining?: number; recommendation?: string
  reserve: number; capacity: number; selected: number; reason: string | null
}

export interface BroadcastPlan {
  generatedAt: string
  computedAt: string | null
  endsAt: string
  total: number
  selected: number
  pending: number
  lines: PlannedLine[]
  contacts: PlannedContact[]
  reasons: { code: PlanReason; label: string; count: number }[]
  warnings: string[]
}

const HOUR = 3_600_000
const stamp = (s: string | null) => s ? Date.parse(s) : NaN

/** Operational day uses Argentina time, independently of the server timezone. */
export function todayEndsAt(now: Date, endTime: string): Date {
  const localDay = new Date(now.getTime() - 3 * HOUR).toISOString().slice(0, 10)
  return new Date(`${localDay}T${endTime}:00-03:00`)
}

function inSchedule(line: PlanningLine, at: number) {
  if (line.type === 'cloud' || !line.activeHours) return true
  const date = new Date(at + line.timezoneOffset * HOUR)
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  const [start, end] = line.activeHours
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Conservative estimate at an even hourly pace; never promises future daily resets. */
export function planLineCapacity(line: PlanningLine, options: BroadcastPlanOptions, now: Date, templateWaba: string | null): PlannedLine {
  const start = now.getTime(), end = todayEndsAt(now, options.endTime).getTime()
  const used = stamp(line.dayResetAt) <= start ? 0 : line.sentToday
  const reserve = Math.ceil(line.dailyLimit * options.reservePercent / 100)
  let reason: string | null = null
  if (!line.enabled) reason = 'Envíos deshabilitados'
  else if (line.status !== 'active' || !line.connected) reason = 'Línea desconectada o inactiva'
  else if (!line.campaignAllowed) reason = 'No habilitada para campañas'
  else if (options.messageType === 'template' && (line.type !== 'cloud' || line.wabaId !== templateWaba)) reason = 'No compatible con la plantilla'
  else if (options.messageType === 'text' && line.type !== 'evolution') reason = 'Cloud requiere una plantilla para esta difusión'
  else if (line.type === 'cloud' && !line.cloudReady) reason = 'Revisar conexión o credenciales Cloud'
  else if (line.invalidSchedule) reason = 'Revisar horario configurado'
  else if (line.volumeBlocked) reason = line.recommendation ?? 'Revisar la recomendación de volumen'
  else if (end <= start) reason = 'La hora de cierre ya pasó'

  let scheduledCapacity = 0
  if (!reason) {
    let reset = stamp(line.hourResetAt)
    let hourLeft = Math.max(0, line.hourlyLimit - line.sentHour)
    if (reset <= start) { hourLeft = line.hourlyLimit; reset = start + HOUR }
    if (!Number.isFinite(reset)) reset = start + HOUR
    // Minute slices respect fractional and overnight schedules, and short windows.
    for (let at = start; at < end;) {
      if (at >= reset) { hourLeft = line.hourlyLimit; reset = at + HOUR }
      const next = Math.min(end, reset, (Math.floor(at / 60_000) + 1) * 60_000)
      if (inSchedule(line, at)) {
        const amount = Math.min(hourLeft, line.hourlyLimit * (next - at) / HOUR)
        scheduledCapacity += amount
        hourLeft -= amount
      }
      at = next
    }
  }
  const capacity = reason ? 0 : Math.max(0, Math.floor(Math.min(
    line.dailyLimit - used - reserve, scheduledCapacity + 1e-8, line.recommendedRemaining ?? Infinity,
  ) - line.committed))
  if (!reason && !capacity) reason = 'Sin cupo disponible en el horario elegido'
  return { id: line.id, name: line.name, type: line.type, dailyLimit: line.dailyLimit,
    recommendedRemaining:line.recommendedRemaining,recommendation:line.recommendation,
    hourlyLimit: line.hourlyLimit, used, committed: line.committed, reserve, capacity, selected: 0, reason }
}

export function buildBroadcastPlan(input: {
  contacts: PlanningContact[]; lines: PlanningLine[]; options: BroadcastPlanOptions
  now: Date; computedAt: string | null; templateWaba: string | null
  frequencyRule: ContactFrequencyRule; scorerConfig?: ScorerConfig; eligibilityConfig: EligibilityConfig
  warnings?: string[]
}): BroadcastPlan {
  const { options, now } = input
  const selectedLines = input.lines.filter(l => options.lineIds.includes(l.id))
  const lines = selectedLines.map(l => planLineCapacity(l, options, now, input.templateWaba))
  const byId = new Map(lines.map(l => [l.id, l]))
  const weights = new Map(selectedLines.map(l => [l.id, l.priority]))
  const seen = new Set<string>()
  const contacts: PlannedContact[] = []
  const counts = new Map<PlanReason, number>()
  const remainingAffinity = new Map<string,number>()
  for (const c of input.contacts) if (c.hasAssignment && c.assignedLineId)
    remainingAffinity.set(c.assignedLineId,(remainingAffinity.get(c.assignedLineId) ?? 0)+1)
  let selected = 0
  for (const c of [...input.contacts].sort((a,b) => b.score - a.score)) {
    if (c.hasAssignment && c.assignedLineId)
      remainingAffinity.set(c.assignedLineId,(remainingAffinity.get(c.assignedLineId) ?? 1)-1)
    const phone = c.phone.replace(/\D/g, '')
    let reason: PlanReason | null = null
    if (!/^\d{8,15}$/.test(phone)) reason = 'invalid_phone'
    else if (c.deleted || !c.optedIn || c.doNotContact || c.blacklisted) reason = 'excluded'
    else if (c.status !== 'active') reason = 'inactive_status'
    else if (c.alreadyQueued) reason = 'already_queued'
    else if (stamp(c.lastDepositAt) > stamp(c.computedAt)) reason = 'activity_changed'
    else if (seen.has(phone)) reason = 'duplicate'
    if (!reason) {
      seen.add(phone)
      const sinceLast = c.lastSentAt ? Math.max(0, (now.getTime() - stamp(c.lastSentAt)) / HOUR) : null
      const eligible = checkEligibility({ status: c.status, doNotContact: false, optInMarketing: true,
        deletedAt: null, lastDepositAt: c.lastDepositAt ? new Date(c.lastDepositAt) : null,
        segment: c.tier, ltvTier: c.tier, totalDepositAmount: null,
        daysInactive: c.lastDepositAt ? Math.floor((now.getTime() - stamp(c.lastDepositAt)) / (24 * HOUR)) : null,
        daysSinceLastMessage: sinceLast === null ? null : Math.floor(sinceLast / 24),
      }, input.eligibilityConfig)
      if (!eligible.eligible) reason = 'no_longer_eligible'
      else if (calculateRiskScore({ sentToday: c.sentToday, sentThisWeek: c.sentWeek,
        lastSentAt: c.lastSentAt ? new Date(c.lastSentAt) : null, hoursSinceLastSend: sinceLast,
      }, input.frequencyRule, input.scorerConfig).decision === 'BLOCK') reason = 'frequency'
    }
    let line: PlannedLine | undefined
    if (!reason) {
      if (c.hasAssignment) {
        line = c.assignedLineId ? byId.get(c.assignedLineId) : undefined
        if (!line || line.reason) reason = 'assigned_line_unavailable'
        else if (line.selected >= line.capacity) reason = 'assigned_line_full'
      } else {
        // Weighted fair allocation by remaining capacity, stable across repeated previews.
        line = lines.filter(l => l.selected < l.capacity).sort((a,b) =>
          Number(b.capacity-b.selected>(remainingAffinity.get(b.id) ?? 0)) - Number(a.capacity-a.selected>(remainingAffinity.get(a.id) ?? 0)) ||
          (a.selected + 1) / a.capacity - (b.selected + 1) / b.capacity ||
          (weights.get(a.id) ?? 0) - (weights.get(b.id) ?? 0) || a.id.localeCompare(b.id))[0]
        if (!line) reason = 'no_capacity'
      }
      if (!reason && selected >= options.maxContacts) reason = 'selection_limit'
      if (!reason && line) { line.selected++; selected++ }
    }
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1)
    contacts.push({ id: c.id, name: c.name, phone: c.phone, score: c.score, segment: c.segment,
      tier: c.tier, agent: c.agent, lineId: reason ? null : line!.id, reason })
  }
  const warnings = [...(input.warnings ?? [])]
  if (input.computedAt && now.getTime() - stamp(input.computedAt) > 36 * HOUR)
    warnings.push('El cálculo de prioridades tiene más de 36 horas. Actualizalo antes de crear campañas.')
  return { generatedAt: now.toISOString(), computedAt: input.computedAt,
    endsAt: todayEndsAt(now, options.endTime).toISOString(), total: contacts.length, selected,
    pending: contacts.length - selected, contacts, lines, warnings,
    reasons: [...counts].map(([code,count]) => ({ code, count, label: PLAN_REASON_LABELS[code] })) }
}
