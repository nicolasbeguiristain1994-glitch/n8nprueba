// ── Date range ────────────────────────────────────────────────────────────────

export type DateRangePreset = '7d' | '30d' | 'this_month' | '90d' | 'custom'

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

function toISODate(d: Date): string {
  return d.toISOString().split('T')[0]
}

export function computeDateRange(preset: DateRangePreset): { from: string; to: string } {
  const now = new Date()
  const today = toISODate(now)
  switch (preset) {
    case '7d': {
      const f = new Date(now); f.setDate(f.getDate() - 7)
      return { from: toISODate(f), to: today }
    }
    case '30d': {
      const f = new Date(now); f.setDate(f.getDate() - 30)
      return { from: toISODate(f), to: today }
    }
    case 'this_month': {
      const f = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: toISODate(f), to: today }
    }
    case '90d': {
      const f = new Date(now); f.setDate(f.getDate() - 90)
      return { from: toISODate(f), to: today }
    }
    case 'custom':
      return { from: today, to: today }
  }
}

export const DEFAULT_DATE_RANGE: DateRange = {
  preset: '7d',
  ...computeDateRange('7d'),
}

export function formatCustomRange(from: string, to: string): string {
  // Parse as local date to avoid UTC-offset shifting the day
  const parse = (iso: string) => new Date(iso + 'T00:00:00')
  const fmt = (d: Date) =>
    d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
  if (!from || !to) return 'Personalizado'
  if (from === to) return fmt(parse(from))
  return `${fmt(parse(from))} → ${fmt(parse(to))}`
}

// ── Widget types ──────────────────────────────────────────────────────────────

export type WidgetId =
  | 'kpi'
  | 'tasks'
  | 'recent_activity'
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
    id:             'kpi',
    label:          'Métricas clave',
    description:    'KPIs principales: deals, valor, contactos y tareas',
    defaultEnabled: true,
    span:           2,
  },
  {
    id:             'tasks',
    label:          'Tareas pendientes',
    description:    'Tareas activas ordenadas por prioridad y fecha',
    defaultEnabled: true,
    span:           1,
  },
  {
    id:             'recent_activity',
    label:          'Actividad reciente',
    description:    'Últimas acciones registradas en el CRM',
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
