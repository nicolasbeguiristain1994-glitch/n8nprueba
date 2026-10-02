/** Calendar dates use the operating timezone, independently of the browser. */
export function argentinaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

export function shiftDate(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function validDateRange(from: string, to: string): boolean {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(`${day}T12:00:00Z`))
    && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day
  return valid(from) && valid(to) && from <= to
}

/** Format PostgreSQL decimal strings without converting money to floating point. */
export function formatPesos(value: string | number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value))
  if (!match) return '—'
  const [, sign, whole, fraction = ''] = match
  const cents = BigInt(whole) * BigInt(100) + BigInt((fraction + '00').slice(0, 2))
    + (Number(fraction[2] ?? '0') >= 5 ? BigInt(1) : BigInt(0))
  return `${sign && cents > 0 ? '-' : ''}$ ${(cents / BigInt(100)).toLocaleString('es-AR')},${String(cents % BigInt(100)).padStart(2, '0')}`
}

/** The Argenbet panel truncates its aggregated original amount to two decimals. */
export function formatProviderPesos(value: string | number, platform: string): string {
  return formatPesos(platform === 'argenbet' ? String(value).replace(/(\.\d{2})\d+$/, '$1') : value)
}

/** Sum the displayed platform amounts in integer cents, including Argenbet truncation. */
export function sumProviderPesos(amounts: { value: string; platform: string }[]): string {
  let total = BigInt(0)
  for (const { value, platform } of amounts) {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
    if (!match) return '—'
    const [, sign, whole, fraction = ''] = match
    const cents = BigInt(whole) * BigInt(100) + BigInt((fraction + '00').slice(0, 2))
      + (platform !== 'argenbet' && Number(fraction[2] ?? '0') >= 5 ? BigInt(1) : BigInt(0))
    total += sign ? -cents : cents
  }
  const absolute = total < BigInt(0) ? -total : total
  return formatPesos(`${total < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`)
}
