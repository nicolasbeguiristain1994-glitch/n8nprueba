import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { validCustomRange } from '@/lib/dashboard-date-range'

// ── Date range ────────────────────────────────────────────────────────────────

export type DateRangePreset = '7d' | '30d' | 'this_month' | '90d' | 'custom'

/**
 * Presets: `to` is an included full day. Custom: `to` is exclusive (00:00 Argentina),
 * so { from: '2026-08-01', to: '2026-09-01' } is all of August. Build API queries
 * with queryDateRange from '@/lib/dashboard-date-range'.
 */
export interface DateRange {
  preset: DateRangePreset
  from: string  // YYYY-MM-DD
  to: string    // YYYY-MM-DD
}

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  '7d':        'Últimos 7 días',
  '30d':       'Últimos 30 días',
  'this_month':'Este mes',
  '90d':       'Últimos 90 días',
  'custom':    'Personalizado',
}

export function computeDateRange(preset: DateRangePreset): { from: string; to: string } {
  const today = argentinaToday()
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : preset === '90d' ? 90 : 1
  return { from: preset === 'this_month' ? `${today.slice(0, 7)}-01` : shiftDate(today, 1 - days), to: today }
}

export const DEFAULT_DATE_RANGE: DateRange = {
  preset: '7d',
  ...computeDateRange('7d'),
}

// ── Widget types ──────────────────────────────────────────────────────────────

export type WidgetId =
  | 'casino_kpi'
  | 'agentes'
  | 'caja'
  | 'vips_riesgo'
  | 'segmentos'
  | 'mensajeria'
  | 'tasks'
  | 'quick_actions'

export interface WidgetConfig {
  id: WidgetId
  label: string
  description: string
  defaultEnabled: boolean
  /** Grid column span: 1 = half, 2 = full */
  span: 1 | 2
}

export const WIDGET_REGISTRY: WidgetConfig[] = [
  {
    id:             'casino_kpi',
    label:          'KPIs Casino',
    description:    'Nuevos, activos, VIP y reactivación urgente',
    defaultEnabled: true,
    span:           2,
  },
  {
    id:             'agentes',
    label:          'Por agente',
    description:    'Totales, VIP, en riesgo y cargas por agente',
    defaultEnabled: true,
    span:           2,
  },
  {
    id:             'caja',
    label:          'Caja',
    description:    'Depósitos y retiros por período y plataforma',
    defaultEnabled: true,
    span:           2,
  },
  {
    id:             'vips_riesgo',
    label:          'VIPs en riesgo',
    description:    'Jugadores VIP/Alto con urgencia de reactivación',
    defaultEnabled: true,
    span:           1,
  },
  {
    id:             'segmentos',
    label:          'Segmentos',
    description:    'Distribución por actividad y nivel de gasto',
    defaultEnabled: true,
    span:           1,
  },
  {
    id:             'mensajeria',
    label:          'WhatsApp',
    description:    'Envíos de las últimas 24 horas y actividad de los últimos 30 días',
    defaultEnabled: true,
    span:           1,
  },
  {
    id:             'tasks',
    label:          'Tareas pendientes',
    description:    'Tareas activas ordenadas por prioridad y fecha',
    defaultEnabled: true,
    span:           1,
  },
  {
    id:             'quick_actions',
    label:          'Acciones rápidas',
    description:    'Atajos directos a las acciones más frecuentes',
    defaultEnabled: true,
    span:           1,
  },
]

export interface DashboardLayout {
  order: WidgetId[]
  hidden: WidgetId[]
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  order:  WIDGET_REGISTRY.map(w => w.id),
  hidden: [],
}

/** Saved presets are relative to today in Argentina; stale or malformed values reset safely. */
export function normalizeDateRange(value: unknown): DateRange {
  const v = value as Partial<DateRange> | null
  if (!v || typeof v !== 'object' || !Object.hasOwn(DATE_RANGE_LABELS, v.preset ?? '')) return { preset: '7d', ...computeDateRange('7d') }
  const preset = v.preset as DateRangePreset
  if (preset !== 'custom') return { preset, ...computeDateRange(preset) }
  if (typeof v.from !== 'string' || typeof v.to !== 'string' || !validDateRange(v.from, v.to)) return { preset: '7d', ...computeDateRange('7d') }
  // An empty custom range (saved before custom ends became exclusive) meant that single full day.
  if (!validCustomRange(v.from, v.to)) return { preset, from: v.from, to: shiftDate(v.from, 1) }
  return { preset, from: v.from, to: v.to }
}
