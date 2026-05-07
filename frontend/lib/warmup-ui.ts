import type { DelayPreset, RandomnessLevel } from './warmup-engine'

// RandomnessLevel is defined in warmup-engine and re-exported here for UI consumers.
export type { RandomnessLevel }

export interface AntiBanValues {
  enabled:     boolean
  delayMin:    number
  delayMax:    number
  windowStart: string   // "HH:MM"
  windowEnd:   string   // "HH:MM"
  activeDays:  number[] // 1=Mon … 7=Sun
  randomness:  RandomnessLevel
  naturalDist: boolean
}

export const AB_DEFAULTS: AntiBanValues = {
  enabled:     false,
  delayMin:    45,
  delayMax:    180,
  windowStart: '09:00',
  windowEnd:   '22:00',
  activeDays:  [1, 2, 3, 4, 5, 6, 7],
  randomness:  'medium',
  naturalDist: false,
}

export interface AntiBanPreset {
  key:    string
  label:  string
  desc:   string
  badge:  string
  config: Omit<AntiBanValues, 'enabled'>
}

export const ANTI_BAN_PRESETS: AntiBanPreset[] = [
  {
    key:   'conservadora',
    label: 'Conservadora',
    desc:  'Delays altos, horario corto, solo días hábiles',
    badge: 'bg-blue-100 text-blue-700',
    config: {
      delayMin:    120,
      delayMax:    360,
      windowStart: '10:00',
      windowEnd:   '19:00',
      activeDays:  [1, 2, 3, 4, 5],
      randomness:  'high',
      naturalDist: true,
    },
  },
  {
    key:   'natural',
    label: 'Natural',
    desc:  'Simula comportamiento humano con variación orgánica',
    badge: 'bg-green-100 text-green-700',
    config: {
      delayMin:    45,
      delayMax:    180,
      windowStart: '09:00',
      windowEnd:   '21:00',
      activeDays:  [1, 2, 3, 4, 5, 6],
      randomness:  'high',
      naturalDist: true,
    },
  },
  {
    key:   'agresiva',
    label: 'Agresiva Controlada',
    desc:  'Mayor velocidad con protección básica habilitada',
    badge: 'bg-orange-100 text-orange-700',
    config: {
      delayMin:    20,
      delayMax:    90,
      windowStart: '09:00',
      windowEnd:   '22:00',
      activeDays:  [1, 2, 3, 4, 5, 6, 7],
      randomness:  'medium',
      naturalDist: false,
    },
  },
]

export const RANDOMNESS_CFG: Record<RandomnessLevel, { label: string; desc: string }> = {
  low:    { label: 'Bajo',  desc: 'Delays uniformes, predecibles' },
  medium: { label: 'Medio', desc: 'Variación moderada' },
  high:   { label: 'Alto',  desc: 'Variación máxima, más humano' },
}

export const DAYS_ES       = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
export const DAYS_FULL_ES  = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

// ── Ban risk ────────────────────────────────────────────────────────────────────
export function banRiskScore(n: WarmupBase & {
  messages_sent_today?: number
  daily_limit?:         number
}): number {
  if (n.warmup_status === 'banned') return 100

  const health = healthScore(n)
  let risk = Math.max(0, 100 - health)

  // Inactivity penalty
  if (n.last_message_at && n.warmup_status === 'active') {
    const days = (Date.now() - new Date(n.last_message_at).getTime()) / 86_400_000
    if (days >= 5)      risk += 20
    else if (days >= 3) risk += 10
  }

  // Near daily limit
  const sent  = n.messages_sent_today ?? 0
  const limit = n.daily_limit ?? 0
  if (limit > 0 && sent / limit >= 0.95) risk += 10

  return Math.min(100, Math.round(risk))
}

export function banRiskLabel(score: number): string {
  if (score >= 70) return 'Alto'
  if (score >= 40) return 'Medio'
  return 'Bajo'
}

export function banRiskCls(score: number): { bg: string; text: string; dot: string; border: string } {
  if (score >= 70) return { bg: 'bg-red-100',   text: 'text-red-700',   dot: 'bg-red-500',   border: 'border-red-200'   }
  if (score >= 40) return { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-400', border: 'border-amber-200' }
  return              { bg: 'bg-green-100',  text: 'text-green-700', dot: 'bg-green-400', border: 'border-green-200' }
}

export interface WarmupBase {
  warmup_status: 'active' | 'paused' | 'completed' | 'banned'
  current_day:     number
  target_days:     number
  last_message_at: string | null
}

export const STATUS_CFG: Record<string, { label: string; cls: string; dotCls: string }> = {
  active:    { label: 'Calentando', cls: 'bg-amber-100 text-amber-700',   dotCls: 'bg-amber-400' },
  paused:    { label: 'En Riesgo',  cls: 'bg-orange-100 text-orange-700', dotCls: 'bg-orange-400' },
  completed: { label: 'Saludable',  cls: 'bg-green-100 text-green-700',   dotCls: 'bg-green-500' },
  banned:    { label: 'Baneada',    cls: 'bg-red-100 text-red-700',       dotCls: 'bg-red-500' },
}

export const STRATEGIES: {
  key: DelayPreset; label: string; desc: string
  targetDays: number; dailyLimit: number; cls: string
}[] = [
  { key: 'conservadora', label: 'Lenta',     desc: 'Progresión suave · menor riesgo de ban',
    targetDays: 30, dailyLimit: 5,  cls: 'border-blue-300 bg-blue-50 text-blue-700' },
  { key: 'normal',       label: 'Media',     desc: 'Equilibrio entre velocidad y seguridad',
    targetDays: 21, dailyLimit: 10, cls: 'border-amber-300 bg-amber-50 text-amber-700' },
  { key: 'agresiva',     label: 'Agresiva',  desc: 'Calentamiento rápido · mayor riesgo',
    targetDays: 14, dailyLimit: 15, cls: 'border-red-300 bg-red-50 text-red-700' },
]

export const PRESET_BADGE: Record<DelayPreset, string> = {
  conservadora: 'bg-blue-100 text-blue-600',
  normal:       'bg-amber-100 text-amber-600',
  agresiva:     'bg-red-100 text-red-600',
}
export const PRESET_LABEL: Record<DelayPreset, string> = {
  conservadora: 'Lenta',
  normal:       'Media',
  agresiva:     'Agresiva',
}

export function healthScore(n: WarmupBase): number {
  if (n.warmup_status === 'banned')    return 0
  if (n.warmup_status === 'completed') return 100
  const progress = n.target_days > 0 ? Math.min(n.current_day / n.target_days, 1) : 0
  let inactivityPenalty = 0
  if (n.last_message_at && n.warmup_status === 'active') {
    const daysSince = (Date.now() - new Date(n.last_message_at).getTime()) / 86_400_000
    if (daysSince > 2) inactivityPenalty = Math.min(Math.round((daysSince - 2) * 5), 25)
  }
  if (n.warmup_status === 'paused')
    return Math.max(5,  Math.round(25 + progress * 20) - inactivityPenalty)
  return   Math.max(10, Math.round(30 + progress * 55) - inactivityPenalty)
}

export function healthColor(score: number): string {
  if (score === 0)  return 'bg-red-500'
  if (score < 35)   return 'bg-orange-400'
  if (score < 60)   return 'bg-amber-400'
  if (score < 80)   return 'bg-lime-500'
  return 'bg-green-500'
}

export function healthLabel(score: number): string {
  if (score === 0)  return 'Baneada'
  if (score < 35)   return 'Crítico'
  if (score < 60)   return 'Regular'
  if (score < 80)   return 'Buena'
  return 'Óptima'
}

export function fmtPhone(phone: string): string {
  const d = phone.replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('549'))
    return `+54 9 ${d.slice(3, 5)} ${d.slice(5, 9)}-${d.slice(9)}`
  return phone
}

export function timeAgo(isoDate: string | null): { relative: string; abs: string } {
  if (!isoDate) return { relative: 'Nunca enviado', abs: '' }
  const diff  = Date.now() - new Date(isoDate).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  const relative =
    mins  < 2    ? 'hace un momento'
    : mins  < 60 ? `hace ${mins} min`
    : hours < 24 ? `hace ${hours}h`
    : days === 1 ? 'ayer'
    : `hace ${days} días`
  const abs = new Date(isoDate).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  return { relative, abs }
}

export function exportWarmupCSV(numbers: Array<{
  phone_number:        string
  display_name:        string | null
  instance_name:       string
  warmup_status:       string
  delay_preset:        string
  current_day:         number
  target_days:         number
  messages_sent_today: number
  total_messages_sent: number
  daily_limit:         number
  last_message_at:     string | null
}>, filename = 'warmup'): void {
  const headers = [
    'Teléfono', 'Nombre', 'Instancia', 'Estado', 'Estrategia',
    'Día actual', 'Días objetivo', 'Mensajes hoy', 'Mensajes total',
    'Límite diario', 'Última actividad',
  ]
  const rows = numbers.map(n => [
    n.phone_number,
    n.display_name ?? n.instance_name,
    n.instance_name,
    n.warmup_status,
    n.delay_preset,
    n.current_day,
    n.target_days,
    n.messages_sent_today,
    n.total_messages_sent,
    n.daily_limit,
    n.last_message_at
      ? new Date(n.last_message_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '',
  ])
  const csv  = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `${filename}-${new Date().toISOString().slice(0, 10)}.csv`,
  })
  a.click()
  URL.revokeObjectURL(url)
}
