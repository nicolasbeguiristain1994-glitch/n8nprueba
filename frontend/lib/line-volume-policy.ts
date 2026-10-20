/** Advisory only: these are panel defaults, never Meta limits or permission to send. */
export const LINE_VOLUME_TIME_ZONE = 'America/Argentina/Buenos_Aires'
export const LINE_VOLUME_POLICY_VERSION = '2026-10-v1'
export const LINE_VOLUME_STEPS = [10, 25, 50, 75, 100, 150, 200, 300, 500] as const
const DAY_MS = 86_400_000
const REQUIRED_DAYS = 3

export interface LineVolumeDay {
  date: string
  attempted: number
  accepted: number
  delivered: number
  failed: number
  ecosystemRejected: number
  optOuts: number
  lastSentAt: string | null
  unknown?: number
}

export interface LineVolumeInput {
  id: string
  lineType: string
  status: string
  isConnected: boolean
  sendingEnabled: boolean
  campaignsAllowed: boolean
  dailyLimit: number
  hourlyLimit: number
  dailyUsed: number
  hourlyUsed: number
  cloudStatus: string | null
  quality: string | null
  lastMetaCheckAt: string | null
  activeRiskReasons: string[]
  recentDays: LineVolumeDay[]
  now: string
  evidenceIncomplete?: boolean
  lastRiskAt?: string | null
}

export interface LineVolumeRecommendation {
  status: 'start' | 'increase' | 'hold' | 'reduce' | 'stop' | 'unavailable'
  suggestedToday: number | null
  attemptedToday: number
  acceptedToday: number
  remainingToday: number | null
  availableNow: number | null
  nextHealthyDay: number | null
  stage: number
  qualifyingDays: number
  requiredDays: number
  reason: string
  reasons: string[]
  evaluatedAt: string
  date: string
  timeZone: string
  quality: string | null
  deliveryRate: number | null
  failureRate: number | null
  optOuts: number
  sampleSize: number
  lastMetaCheckAt: string | null
  recentDays: LineVolumeDay[]
  dailyLimit: number
  policyVersion: string
}

export function lineVolumeDate(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LINE_VOLUME_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

function dayTime(date: string): number { return Date.parse(`${date}T00:00:00Z`) }
function count(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0 }
function emptyDay(date: string): LineVolumeDay {
  return { date, attempted: 0, accepted: 0, delivered: 0, failed: 0,
    ecosystemRejected: 0, optOuts: 0, lastSentAt: null, unknown: 0 }
}
function mature(day: LineVolumeDay, now: number): boolean {
  const sent = Date.parse(day.lastSentAt ?? '')
  return Number.isFinite(sent) && now - sent >= 12 * 3_600_000
}
function adverse(day: LineVolumeDay, settled: boolean): boolean {
  return day.optOuts > 0 || day.ecosystemRejected > 0
    || (day.attempted >= 10 && (day.failed / day.attempted > 0.10
      || (settled && day.delivered / day.attempted < 0.80)))
}

/** Rebuild from closed days so refreshes cannot repeatedly raise or lower the stage. */
export function recommendLineVolume(input: LineVolumeInput): LineVolumeRecommendation {
  const now = Date.parse(input.now)
  const date = lineVolumeDate(input.now)
  const todayAt = dayTime(date)
  const rawDays = input.recentDays.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date)
    && dayTime(d.date) >= todayAt - 27 * DAY_MS && d.date <= date)
    .map(d => ({ ...d, attempted: count(d.attempted), accepted: count(d.accepted),
      delivered: count(d.delivered), failed: count(d.failed),
      ecosystemRejected: count(d.ecosystemRejected), optOuts: count(d.optOuts), unknown: count(d.unknown ?? 0) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  // The reader groups by date. Treat accidental duplicate days as incomplete,
  // never as additional successful days or a reason to multiply the budget.
  const byDate = new Map<string, LineVolumeDay>()
  for (const day of rawDays) {
    const previous = byDate.get(day.date)
    byDate.set(day.date, previous ? { ...previous, unknown: Math.max(previous.unknown ?? 0, 1),
      failed: Math.max(previous.failed, day.failed), optOuts: Math.max(previous.optOuts, day.optOuts),
      ecosystemRejected: Math.max(previous.ecosystemRejected, day.ecosystemRejected) } : day)
  }
  const days = [...byDate.values()]
  const today = days.find(d => d.date === date) ?? emptyDay(date)
  const lastWeek = days.filter(d => dayTime(d.date) >= todayAt - 6 * DAY_MS)
  const settled = lastWeek.filter(d => d.date < date && mature(d, now))
  const sampleSize = settled.reduce((n, d) => n + d.attempted, 0)
  const dailyLimit = count(input.dailyLimit)
  const base: LineVolumeRecommendation = {
    status: 'start', suggestedToday: null, attemptedToday: today.attempted, acceptedToday: today.accepted,
    remainingToday: null, availableNow: null, nextHealthyDay: null, stage: 1,
    qualifyingDays: 0, requiredDays: REQUIRED_DAYS, reason: '', reasons: [],
    evaluatedAt: input.now, date, timeZone: LINE_VOLUME_TIME_ZONE, quality: input.quality,
    deliveryRate: sampleSize ? settled.reduce((n, d) => n + d.delivered, 0) / sampleSize : null,
    failureRate: sampleSize ? settled.reduce((n, d) => n + d.failed, 0) / sampleSize : null,
    optOuts: lastWeek.reduce((n, d) => n + d.optOuts, 0), sampleSize,
    lastMetaCheckAt: input.lastMetaCheckAt, recentDays: days.slice(-7), dailyLimit,
    policyVersion: LINE_VOLUME_POLICY_VERSION,
  }
  const stop = (status: 'stop' | 'unavailable', reasons: string[]): LineVolumeRecommendation => ({
    ...base, status, suggestedToday: 0, remainingToday: 0, availableNow: 0,
    reason: reasons[0], reasons,
  })
  if (input.activeRiskReasons.length) return stop('stop', input.activeRiskReasons)
  if (['YELLOW', 'RED'].includes(input.quality ?? ''))
    return stop('stop', ['La calidad de Meta está en advertencia. Revisá la alerta antes de iniciar nuevas campañas.'])
  if (input.status !== 'active' || !input.isConnected || !input.sendingEnabled || !input.campaignsAllowed
    || (input.lineType === 'cloud' && input.cloudStatus !== 'active'))
    return stop('stop', ['La línea no está habilitada para campañas. Revisá su conexión y configuración.'])
  if (input.lineType === 'cloud') {
    const checked = Date.parse(input.lastMetaCheckAt ?? '')
    if (!Number.isFinite(checked) || now - checked < 0 || now - checked > 6 * 60_000)
      return stop('unavailable', ['Falta una verificación reciente de Meta. Esperá la próxima comprobación antes de enviar.'])
  }

  const recoveryDay = input.lastRiskAt ? lineVolumeDate(input.lastRiskAt) : null
  // Reviewing an incident must not raise a previously reduced recommendation.
  let step = recoveryDay ? 0 : 1
  let qualifyingDays = 0
  let qualifyingSample = 0
  let lastActivity = Number.NEGATIVE_INFINITY
  let lastAdverse = recoveryDay ? dayTime(recoveryDay) : Number.NEGATIVE_INFINITY
  let lastDecision: 'start' | 'increase' | 'hold' | 'reduce' = recoveryDay ? 'reduce' : 'start'
  const canIncrease = input.lineType === 'cloud' && input.quality === 'GREEN' && !input.evidenceIncomplete
  for (const day of days.filter(d => d.date < date && (!recoveryDay || d.date > recoveryDay))) {
    const at = dayTime(day.date)
    if (day.attempted === 0 && day.optOuts === 0) continue
    if (at - lastActivity >= 7 * DAY_MS) {
      step = Math.min(step, 1); qualifyingDays = 0; qualifyingSample = 0
      lastDecision = step === 0 ? 'reduce' : 'start'
    }
    lastActivity = at
    const isMature = mature(day, now)
    if (adverse(day, isMature)) {
      step = Math.max(0, step - 1); qualifyingDays = 0; qualifyingSample = 0
      lastAdverse = at; lastDecision = 'reduce'; continue
    }
    const target = LINE_VOLUME_STEPS[step]
    const favorable = canIncrease && isMature && (day.unknown ?? 0) === 0
      && at - lastAdverse >= 7 * DAY_MS
      && day.attempted >= Math.ceil(target * .8)
      && day.delivered / day.attempted >= .90 && day.failed / day.attempted <= .05
    if (!favorable) continue
    qualifyingDays += 1; qualifyingSample += day.attempted
    if (qualifyingDays >= REQUIRED_DAYS && qualifyingSample >= Math.max(50, Math.ceil(target * 1.5))
      && step < LINE_VOLUME_STEPS.length - 1) {
      step += 1; qualifyingDays = 0; qualifyingSample = 0; lastDecision = 'increase'
    }
  }
  if (todayAt - lastActivity >= 7 * DAY_MS) {
    step = Math.min(step, 1); qualifyingDays = 0; qualifyingSample = 0
    lastDecision = step === 0 ? 'reduce' : 'start'
  }
  // Deterioration can reduce today's advice immediately; fresh pending receipts alone cannot.
  if (adverse(today, mature(today, now))) {
    step = Math.max(0, step - 1); qualifyingDays = 0; lastDecision = 'reduce'
    lastAdverse = todayAt
  }
  if (today.attempted >= 50 && today.ecosystemRejected >= 10
    && today.ecosystemRejected / today.attempted >= .20)
    return stop('stop', ['Aumentaron los rechazos preventivos de Meta. Revisá frecuencia y audiencia antes de enviar más.'])
  // A withdrawal may answer an older campaign: never infer its rate from today's sends alone.
  if (today.optOuts >= 5)
    return stop('stop', ['Se registraron varias solicitudes de baja hoy. Revisá consentimiento y contenido antes de continuar.'])

  if (!canIncrease) { step = Math.min(step, 1); qualifyingDays = 0 }
  const suggestedToday = Math.min(LINE_VOLUME_STEPS[step], dailyLimit)
  const remainingToday = Math.max(0, Math.min(suggestedToday - today.attempted,
    dailyLimit - count(input.dailyUsed)))
  const availableNow = Math.max(0, Math.min(remainingToday, count(input.hourlyLimit) - count(input.hourlyUsed)))
  const next = LINE_VOLUME_STEPS[step + 1]
  const nextHealthyDay = canIncrease && next && dailyLimit > suggestedToday ? Math.min(next, dailyLimit) : null
  const reasons: string[] = []
  let status: LineVolumeRecommendation['status'] = lastDecision
  if (lastDecision === 'reduce') reasons.push('Los resultados aconsejan reducir el volumen y revisar audiencia, frecuencia y contenido.')
  else if (lastDecision === 'increase') reasons.push('La línea acumuló días con resultados favorables; se recomienda un aumento gradual.')
  else if (qualifyingDays > 0) { status = 'hold'; reasons.push(`Mantener el volumen: ${qualifyingDays} de ${REQUIRED_DAYS} días con evidencia suficiente para el próximo escalón.`) }
  else reasons.push('Empezá con un volumen pequeño. Los días sin actividad o con pocas muestras no habilitan aumentos.')
  if (input.lineType !== 'cloud') reasons.push('Orientación provisional: esta línea no tiene verificación oficial de calidad de Meta. No se proponen aumentos automáticos.')
  else if (input.quality !== 'GREEN') reasons.push('La calidad todavía no está confirmada como alta; no se recomienda aumentar.')
  if (input.evidenceIncomplete) reasons.push('El historial tiene reintentos o resultados incompletos; hace falta evidencia más clara para aumentar.')
  if (recoveryDay) reasons.push('Después de una alerta se retoma desde un volumen reducido; revisar la alerta no habilita aumentar por sí solo.')
  if (todayAt - lastAdverse < 7 * DAY_MS) reasons.push('Esperá al menos 7 días sin nuevas señales desfavorables antes de considerar un aumento.')
  if (dailyLimit < LINE_VOLUME_STEPS[step]) reasons.push('La recomendación está acotada por el límite configurado en el panel.')
  if (today.attempted >= suggestedToday) reasons.push('Ya se alcanzó el total recomendado para hoy; no se aconsejan más envíos de campaña.')
  else if (!remainingToday) reasons.push('El cupo configurado está agotado; esperá su renovación.')
  else if (!availableNow) reasons.push('El cupo horario está agotado; esperá su renovación.')
  return { ...base, status, suggestedToday, remainingToday, availableNow, nextHealthyDay,
    stage: step, qualifyingDays: Math.min(qualifyingDays, REQUIRED_DAYS), reason: reasons[0], reasons }
}
