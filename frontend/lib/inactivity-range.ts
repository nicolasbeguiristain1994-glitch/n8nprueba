export type InactivityRange = { min: string; max: string; mode?: 'period' | 'missing' }
export const EMPTY_INACTIVITY: InactivityRange = { min: '', max: '' }

export function hasInactivityFilter(range: InactivityRange): boolean {
  return range.mode === 'missing' || range.min !== '' || range.max !== ''
}

// Browser views now express inactivity; keep their selected bounds. Stored
// dynamic audiences retain the historical API period mode for compatibility.
export function normalizeContactInactivity(range: InactivityRange): InactivityRange {
  return range.mode === 'period' ? { min: range.min, max: range.max } : range
}

export function inactivityError({ min, max, mode }: InactivityRange): string | null {
  if (mode === 'missing' && (min !== '' || max !== '')) return 'Sin movimientos registrados no admite un rango de días.'
  if ([min, max].some(v => v !== '' && (!/^\d+$/.test(v) || Number(v) > 36500))) {
    return 'Ingresá días enteros entre 0 y 36500.'
  }
  if (min !== '' && max !== '' && Number(max) <= Number(min)) {
    return 'Hasta debe ser mayor que Más de.'
  }
  return null
}

export function inactivityParams(range: InactivityRange): Record<string, string> {
  if (range.mode === 'missing') return { movimiento_modo: 'sin_historial' }
  return {
    ...((range.min !== '' || range.max !== '') && range.mode === 'period' ? { movimiento_modo: 'periodo' } : {}),
    ...(range.min !== '' ? { inactividad_desde: range.min } : {}),
    ...(range.max !== '' ? { inactividad_hasta: range.max } : {}),
  }
}

export function inactivityLabel({ min, max, mode }: InactivityRange): string {
  if (mode === 'missing') return 'Sin movimientos registrados'
  if (mode === 'period') {
    if (min !== '' && max !== '') return `Con movimientos hace más de ${min} y hasta ${max} días`
    if (min !== '') return `Con movimientos hace más de ${min} días`
    if (max !== '') return `Con movimientos hasta hace ${max} días`
    return 'Con movimientos en el período'
  }
  if (min !== '' && max !== '') return `Más de ${min} y hasta ${max} días sin movimientos`
  if (min !== '') return `Más de ${min} días sin movimientos`
  if (max !== '') return `Hasta ${max} días sin movimientos`
  return 'Días desde el último movimiento'
}
