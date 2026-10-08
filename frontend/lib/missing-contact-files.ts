import type { MissingContact, MissingContactImportRow } from './missing-contact-types'

// XLSX cells are written as strings, including phones and usernames beginning
// with '='. Do not create formula cells from untrusted account names.
export function missingContactSheetRows(rows: MissingContact[]) {
  return [
    ['Usuario', 'Plataforma', 'Agente', 'Nombre', 'Celular', 'Último movimiento', 'Detectado en el sistema'],
    ...rows.map(r => [r.username, r.platform, r.agent, '', '', r.last_movement ?? '',
      r.first_seen_at ? new Date(r.first_seen_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '']),
  ]
}

const headerKey = (v: unknown) => String(v ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export function parseMissingContactSheet(rows: unknown[][]): MissingContactImportRow[] {
  const headers = (rows[0] ?? []).map(headerKey)
  const column = (...names: string[]) => headers.findIndex(h => names.includes(h))
  const user = column('usuario', 'username')
  const platform = column('plataforma', 'platform')
  const agent = column('agente', 'agent')
  const phone = column('celular', 'telefono', 'phone')
  const name = column('nombre', 'name')
  if ([user, platform, agent, phone].some(i => i < 0)) {
    throw new Error('El archivo debe incluir Usuario, Plataforma, Agente y Celular. Usá la planilla descargada desde esta sección.')
  }
  const value = (row: unknown[], index: number) => String(row[index] ?? '').trim()
  return rows.slice(1).flatMap((r, i) => r.every(v => String(v ?? '').trim() === '') ? [] : [{
    row: i + 2, username: value(r, user), platform: value(r, platform).toLowerCase(),
    agent: value(r, agent).toLowerCase(), name: name >= 0 ? value(r, name) : '', phone: value(r, phone),
  }])
}

/** Require the country code: never guess a country or add Argentina's mobile 9. */
export function normalizeMissingContactPhone(raw: string): string | null {
  if (!/^[+\d\s().-]+$/.test(raw)) return null
  let phone = raw.replace(/[\s().-]/g, '')
  if (phone.startsWith('00')) phone = '+' + phone.slice(2)
  if (/^\d+$/.test(phone)) phone = '+' + phone
  return /^\+[1-9]\d{9,14}$/.test(phone) ? phone : null
}
