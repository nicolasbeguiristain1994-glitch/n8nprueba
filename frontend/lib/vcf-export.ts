/**
 * VCard 3.0 export service.
 * RFC 2426 (vCard 3.0) + RFC 2425 (MIME Content-Type for Directory Information)
 * Compatible con Gmail, iPhone, Android, Outlook.
 */

export interface ExportableContact {
  id: string
  phone_number: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  panel?: string | null
  linea?: number | null
  segment?: string | null
  gaming?: string | null
  actividad?: string | null
  valor_riesgo?: string | null
  antiguedad?: string | null
  opt_in?: boolean
  created_at?: string | null
}

const NIVEL_LABEL: Record<string, string> = {
  bajo: 'Bajo', medio: 'Medio', alto: 'Vip', vip: 'Super Vip',
}

// Escapa caracteres especiales según RFC 2426 §4
function escapeVcardText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
}

// RFC 2425 §5.8.1: líneas de más de 75 caracteres deben doblarse con CRLF + espacio
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = [line.slice(0, 75)]
  let rest = line.slice(75)
  while (rest.length > 0) {
    parts.push(' ' + rest.slice(0, 74))
    rest = rest.slice(74)
  }
  return parts.join('\r\n')
}

export function contactToVCard(contact: ExportableContact): string {
  const lines: string[] = []

  lines.push('BEGIN:VCARD')
  lines.push('VERSION:3.0')

  const firstName = contact.first_name?.trim() ?? ''
  const lastName  = contact.last_name?.trim() ?? ''
  const fullName  = [firstName, lastName].filter(Boolean).join(' ')

  // FN es obligatorio en vCard 3.0
  lines.push(foldLine(`FN:${escapeVcardText(fullName || contact.phone_number)}`))
  // N: Family;Given;Additional;Prefix;Suffix
  lines.push(foldLine(`N:${escapeVcardText(lastName)};${escapeVcardText(firstName)};;;`))

  lines.push(`TEL;TYPE=CELL:${contact.phone_number}`)

  if (contact.email?.trim()) {
    lines.push(foldLine(`EMAIL;TYPE=INTERNET:${escapeVcardText(contact.email.trim())}`))
  }

  if (contact.panel?.trim()) {
    lines.push(foldLine(`ORG:${escapeVcardText(contact.panel.trim())}`))
  }

  // NOTE contiene toda la metadata relevante
  const noteParts: string[] = []
  if (contact.segment)          noteParts.push(`Nivel: ${NIVEL_LABEL[contact.segment] ?? contact.segment}`)
  if (contact.gaming)           noteParts.push(`Juego: ${contact.gaming}`)
  if (contact.linea != null)    noteParts.push(`Línea: ${contact.linea}`)
  if (contact.actividad)        noteParts.push(`Actividad: ${contact.actividad}`)
  if (contact.antiguedad)       noteParts.push(`Antigüedad: ${contact.antiguedad}`)
  if (contact.valor_riesgo)     noteParts.push(`Riesgo: ${contact.valor_riesgo}`)
  if (contact.opt_in !== undefined) noteParts.push(`Opt-in: ${contact.opt_in ? 'sí' : 'no'}`)
  if (noteParts.length > 0) {
    lines.push(foldLine(`NOTE:${escapeVcardText(noteParts.join(' | '))}`))
  }

  // CATEGORIES para facilitar filtrado en gestores de contactos
  const categories = [
    contact.segment && (NIVEL_LABEL[contact.segment] ?? contact.segment),
    contact.gaming,
    contact.panel,
    contact.actividad,
  ].filter((v): v is string => Boolean(v))
  if (categories.length > 0) {
    lines.push(foldLine(`CATEGORIES:${categories.map(escapeVcardText).join(',')}`))
  }

  const rev = contact.created_at
    ? new Date(contact.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z')
    : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  lines.push(`REV:${rev}`)

  lines.push('END:VCARD')

  return lines.join('\r\n')
}

/** Concatena múltiples bloques VCard en un único string VCF */
export function generateVcfContent(contacts: ExportableContact[]): string {
  return contacts.map(contactToVCard).join('\r\n')
}

/** Divide un array en chunks de tamaño `size` */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size < 1) throw new Error('El tamaño del chunk debe ser mayor a 0')
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Descarga todos los contactos en un único archivo .vcf */
export function downloadSingleVcf(contacts: ExportableContact[], filename: string): void {
  const content = generateVcfContent(contacts)
  const blob    = new Blob([content], { type: 'text/vcard;charset=utf-8' })
  triggerDownload(blob, filename)
}

/**
 * Divide los contactos en chunks y los descarga dentro de un archivo ZIP.
 * Usa fflate (importado dinámicamente) para compatibilidad con SSR.
 */
export async function downloadZippedVcf(
  contacts: ExportableContact[],
  batchSize: number,
  filenameBase: string,
): Promise<void> {
  const { zipSync, strToU8 } = await import('fflate')

  const chunks = chunkArray(contacts, batchSize)
  const files: Record<string, Uint8Array> = {}

  for (let i = 0; i < chunks.length; i++) {
    const partNum  = String(i + 1).padStart(2, '0')
    const partName = `${filenameBase}_parte_${partNum}.vcf`
    files[partName] = strToU8(generateVcfContent(chunks[i]))
  }

  const zipped = zipSync(files, { level: 6 })
  // zipSync siempre retorna un Uint8Array con ArrayBuffer ordinario
  const blob   = new Blob([(zipped.buffer as ArrayBuffer).slice(0)], { type: 'application/zip' })
  triggerDownload(blob, `${filenameBase}.zip`)
}
