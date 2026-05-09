import { describe, it, expect } from 'vitest'
import { contactToVCard, generateVcfContent, chunkArray } from '../vcf-export'
import type { ExportableContact } from '../vcf-export'

/** Deshace el line-folding del RFC 2425 antes de verificar contenido */
function unfold(vcard: string): string {
  return vcard.replace(/\r\n[ \t]/g, '')
}

// Contacto de referencia con todos los campos
const fullContact: ExportableContact = {
  id: 'abc-123',
  phone_number: '+5491112345678',
  first_name: 'Juan',
  last_name: 'Pérez',
  email: 'juan@example.com',
  panel: 'betcoin',
  linea: 3,
  segment: 'alto',
  gaming: 'slots',
  actividad: 'frecuente',
  antiguedad: 'veterano',
  valor_riesgo: 'bajo',
  opt_in: true,
  created_at: '2024-01-15T10:00:00.000Z',
}

describe('contactToVCard', () => {
  it('genera un bloque VCard válido con BEGIN y END', () => {
    const vcard = contactToVCard(fullContact)
    expect(vcard).toContain('BEGIN:VCARD')
    expect(vcard).toContain('VERSION:3.0')
    expect(vcard).toContain('END:VCARD')
  })

  it('mapea correctamente nombre, teléfono y email', () => {
    const vcard = contactToVCard(fullContact)
    expect(vcard).toContain('FN:Juan Pérez')
    expect(vcard).toContain('N:Pérez;Juan;;;')
    expect(vcard).toContain('TEL;TYPE=CELL:+5491112345678')
    expect(vcard).toContain('EMAIL;TYPE=INTERNET:juan@example.com')
    expect(vcard).toContain('ORG:betcoin')
  })

  it('incluye REV con la fecha de created_at', () => {
    const vcard = contactToVCard(fullContact)
    expect(vcard).toContain('REV:2024-01-15T10:00:00Z')
  })

  it('usa el teléfono como FN cuando no hay nombre', () => {
    const contact: ExportableContact = { ...fullContact, first_name: null, last_name: null }
    const vcard = contactToVCard(contact)
    expect(vcard).toContain('FN:+5491112345678')
    expect(vcard).toContain('N:;;;')
  })

  it('omite EMAIL cuando está ausente o vacío', () => {
    expect(contactToVCard({ ...fullContact, email: null })).not.toContain('EMAIL')
    expect(contactToVCard({ ...fullContact, email: '' })).not.toContain('EMAIL')
    expect(contactToVCard({ ...fullContact, email: '   ' })).not.toContain('EMAIL')
  })

  it('omite ORG cuando panel está ausente', () => {
    const vcard = contactToVCard({ ...fullContact, panel: null })
    expect(vcard).not.toContain('ORG')
  })

  it('incluye NOTE con toda la metadata del contacto', () => {
    // Unfold el vCard antes de verificar: RFC 2425 permite romper líneas largas
    const vcard = unfold(contactToVCard(fullContact))
    expect(vcard).toContain('NOTE:')
    expect(vcard).toContain('Nivel: Vip')
    expect(vcard).toContain('Juego: slots')
    expect(vcard).toContain('Línea: 3')
    expect(vcard).toContain('Actividad: frecuente')
    expect(vcard).toContain('Antigüedad: veterano')
    expect(vcard).toContain('Riesgo: bajo')
    expect(vcard).toContain('Opt-in: sí')
  })

  it('omite NOTE cuando no hay metadata', () => {
    const minimal: ExportableContact = { id: '1', phone_number: '+5491100000000' }
    expect(contactToVCard(minimal)).not.toContain('NOTE:')
  })

  it('mapea todos los segmentos a labels legibles', () => {
    const cases = [
      { segment: 'bajo',  label: 'Bajo' },
      { segment: 'medio', label: 'Medio' },
      { segment: 'alto',  label: 'Vip' },
      { segment: 'vip',   label: 'Super Vip' },
    ]
    for (const { segment, label } of cases) {
      const vcard = contactToVCard({ ...fullContact, segment })
      expect(vcard).toContain(`Nivel: ${label}`)
    }
  })

  it('escapa comas en valores de texto (RFC 2426)', () => {
    const contact: ExportableContact = {
      ...fullContact,
      first_name: 'García, Luis',
      last_name: 'López',
    }
    const vcard = contactToVCard(contact)
    expect(vcard).toContain('FN:García\\, Luis López')
  })

  it('escapa punto y coma en valores de texto (RFC 2426)', () => {
    const contact: ExportableContact = {
      ...fullContact,
      last_name: 'López;Pérez',
      first_name: 'Juan',
    }
    const vcard = contactToVCard(contact)
    expect(vcard).toContain('N:López\\;Pérez;Juan;;;')
  })

  it('usa CRLF (\\r\\n) como separador de líneas', () => {
    const vcard = contactToVCard(fullContact)
    expect(vcard).toContain('\r\n')
  })

  it('genera REV con fecha actual cuando created_at es null', () => {
    const contact: ExportableContact = { ...fullContact, created_at: null }
    const vcard = contactToVCard(contact)
    const match = vcard.match(/REV:(.+)/)
    expect(match).not.toBeNull()
    const revDate = new Date(match![1].trim())
    expect(isNaN(revDate.getTime())).toBe(false)
  })

  it('maneja contacto mínimo (solo teléfono)', () => {
    const minimal: ExportableContact = { id: '99', phone_number: '+5491199999999' }
    const vcard = contactToVCard(minimal)
    expect(vcard).toContain('BEGIN:VCARD')
    expect(vcard).toContain('FN:+5491199999999')
    expect(vcard).toContain('TEL;TYPE=CELL:+5491199999999')
    expect(vcard).toContain('END:VCARD')
  })

  it('opt_in false se muestra correctamente', () => {
    const vcard = contactToVCard({ ...fullContact, opt_in: false })
    expect(vcard).toContain('Opt-in: no')
  })
})

describe('chunkArray', () => {
  it('divide exactamente sin remanente', () => {
    const chunks = chunkArray([1, 2, 3, 4], 2)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual([1, 2])
    expect(chunks[1]).toEqual([3, 4])
  })

  it('el último chunk contiene el remanente', () => {
    const chunks = chunkArray([1, 2, 3, 4, 5], 2)
    expect(chunks).toHaveLength(3)
    expect(chunks[2]).toEqual([5])
  })

  it('devuelve array vacío con input vacío', () => {
    expect(chunkArray([], 10)).toEqual([])
  })

  it('devuelve un único chunk cuando size >= length', () => {
    expect(chunkArray([1, 2, 3], 10)).toEqual([[1, 2, 3]])
    expect(chunkArray([1, 2, 3], 3)).toEqual([[1, 2, 3]])
  })

  it('lanza error con size < 1', () => {
    expect(() => chunkArray([1, 2], 0)).toThrow()
    expect(() => chunkArray([1, 2], -5)).toThrow()
  })

  it('simula: 300 contactos / 30 por archivo = 10 archivos exactos', () => {
    const contacts = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      phone_number: `+5491190000${String(i).padStart(4, '0')}`,
    }))
    const chunks = chunkArray(contacts, 30)
    expect(chunks).toHaveLength(10)
    expect(chunks.every(c => c.length === 30)).toBe(true)
  })

  it('simula: 301 contactos / 30 por archivo = 11 archivos (último con 1)', () => {
    const contacts = Array.from({ length: 301 }, (_, i) => ({
      id: String(i),
      phone_number: `+5491190000${String(i).padStart(4, '0')}`,
    }))
    const chunks = chunkArray(contacts, 30)
    expect(chunks).toHaveLength(11)
    expect(chunks[10]).toHaveLength(1)
  })
})

describe('generateVcfContent', () => {
  it('genera un archivo VCF con múltiples bloques VCard', () => {
    const contacts = [
      fullContact,
      { ...fullContact, id: 'xyz', phone_number: '+5491199999999', first_name: 'Ana', last_name: 'García' },
    ]
    const content = generateVcfContent(contacts)
    const cardCount = (content.match(/BEGIN:VCARD/g) ?? []).length
    expect(cardCount).toBe(2)
    expect(content).toContain('Juan Pérez')
    expect(content).toContain('Ana García')
  })

  it('devuelve cadena vacía con array vacío', () => {
    expect(generateVcfContent([])).toBe('')
  })

  it('cada bloque es un VCard completo y válido', () => {
    const content = generateVcfContent([fullContact])
    const begins = (content.match(/BEGIN:VCARD/g) ?? []).length
    const ends   = (content.match(/END:VCARD/g) ?? []).length
    expect(begins).toBe(ends)
    expect(begins).toBe(1)
  })
})
