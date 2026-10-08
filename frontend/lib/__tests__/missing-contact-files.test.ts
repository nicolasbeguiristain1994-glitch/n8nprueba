import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { missingContactSheetRows, normalizeMissingContactPhone, parseMissingContactSheet } from '@/lib/missing-contact-files'

describe('agent spreadsheet round trip', () => {
  it('preserves explicit account identity and phones as text without formulas', () => {
    const data = missingContactSheetRows([{ username: '=test', platform:'zeus', agent:'royal', source_agent:'royal', last_movement:'2026-10-01',first_seen_at:null }])
    data[1][4] = '+5491123456789'
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(data),'Usuarios sin número')
    const parsed = XLSX.read(XLSX.write(book,{type:'array',bookType:'xlsx'}),{type:'array'})
    const sheet = parsed.Sheets[parsed.SheetNames[0]]
    expect(sheet.A2.t).toBe('s'); expect(sheet.A2.f).toBeUndefined()
    expect(parseMissingContactSheet(XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:false}))).toEqual([
      { row:2,username:'=test',platform:'zeus',agent:'royal',name:'',phone:'+5491123456789' },
    ])
  })
  it('keeps source row numbers, blank phones and rejects missing identity columns', () => {
    expect(parseMissingContactSheet([['Usuario','Plataforma','Agente','Teléfono'],[],['jose','ZEUS','Royal','']])).toEqual([
      { row:3,username:'jose',platform:'zeus',agent:'royal',phone:'',name:'' },
    ])
    expect(() => parseMissingContactSheet([['Nombre','Celular']])).toThrow('Usuario')
  })
  it('normalizes common international formats without accepting scientific notation or guessing', () => {
    for (const phone of ['+54 9 (11) 1234-5678','5491112345678','005491112345678']) expect(normalizeMissingContactPhone(phone)).toBe('+5491112345678')
    for (const phone of ['1234','5.491112345678E+12','=1234567890','++5491112345678','texto','000000000000','+5491123456789012345']) expect(normalizeMissingContactPhone(phone)).toBeNull()
  })
})
