export type InactivityRange = { min: string; max: string; mode?: 'period' }
export const EMPTY_INACTIVITY: InactivityRange = { min: '', max: '' }

export function inactivityError({ min, max }: InactivityRange): string | null {
  if ([min, max].some(v => v !== '' && (!/^\d+$/.test(v) || Number(v) > 36500))) {
    return 'Ingresá días enteros entre 0 y 36500.'
  }
  if (min !== '' && max !== '' && Number(max) <= Number(min)) {
    return 'Hasta debe ser mayor que Más de.'
  }
  return null
}

export function inactivityParams(range: InactivityRange): Record<string, string> {
  return {
    ...((range.min !== '' || range.max !== '') && range.mode === 'period' ? { movimiento_modo: 'periodo' } : {}),
    ...(range.min !== '' ? { inactividad_desde: range.min } : {}),
    ...(range.max !== '' ? { inactividad_hasta: range.max } : {}),
  }
}

export function inactivityLabel({ min, max, mode }: InactivityRange): string {
  if (mode === 'period') {
    if (min !== '' && max !== '') return `Con movimientos hace más de ${min} y hasta ${max} días`
    if (min !== '') return `Con movimientos hace más de ${min} días`
    if (max !== '') return `Con movimientos hasta hace ${max} días`
    return 'Con movimientos en el período'
  }
  if (min !== '' && max !== '') return `Más de ${min} y hasta ${max} días sin movimientos`
  if (min !== '') return `Más de ${min} días sin movimientos`
  if (max !== '') return `Hasta ${max} días sin movimientos`
  return 'Días sin movimientos'
}
