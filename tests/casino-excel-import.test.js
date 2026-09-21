const fs = require('fs')
const os = require('os')
const path = require('path')
const XLSX = require('xlsx')
const { readFiles, localDate, amount, recordId } = require('../src/casino-import/excel')
let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-import-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
function file(name, rows) {
  const w = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([
    ['Reporte'], [], ['ID','Fecha','Hora','Jugador','Tipo','Monto'], ...rows,
  ]), 'Movimientos')
  const f = path.join(dir, name); XLSX.writeFile(w, f); return f
}
const row = (id, monto = 14920.67) => [id,'31/08/2026','23:59:59','jugador1','Retiro',monto]
test('preserves UUID, cents and Argentina midnight; repeated downloads deduplicate', () => {
  const a=file('argenbet_adminroyal_2026-08.xlsx',[row('019ca75d-813d-744b-872c-e43cfe761318')])
  const b=file('argenbet_adminroyal_2026-08 (1).xlsx',[row('019ca75d-813d-744b-872c-e43cfe761318')])
  const data=readFiles([a,b]);expect(data.transactions).toHaveLength(1)
  expect(data.transactions[0]).toMatchObject({monto:'14920.67',fecha:'2026-08-31',fecha_hora_utc:'2026-09-01T02:59:59.000Z',platform:'argenbet'})
  expect(data.reports[1].duplicates).toBe(1)
})
test('equal amounts at equal times with distinct IDs and cross-platform IDs survive', () => {
  const a=file('ganamos_adminroyal_2026-08.xlsx',[row('1'),row('2')])
  const b=file('argenbet_adminroyal_2026-08.xlsx',[row('1')])
  expect(readFiles([a,b]).transactions).toHaveLength(3)
})
test('contradictory duplicates fail before any write', () => {
  const a=file('ganamos_adminroyal_2026-08.xlsx',[row('1')])
  const b=file('ganamos_adminroyal_2026-08 (1).xlsx',[row('1',99)])
  expect(()=>readFiles([a,b])).toThrow('contradictorios')
})
test('rejects invalid dates, ambiguous amounts and wrong reporting periods', () => {
  expect(()=>localDate('31/02/2026')).toThrow()
  expect(()=>amount('1.234,56')).toThrow()
  expect(()=>amount(1.234)).toThrow()
  expect(()=>readFiles([file('ganamos_adminroyal_2026-07.xlsx',[row('1')])])).toThrow('período')
  expect(localDate(46235.5)).toBe('2026-08-01')
  expect(recordId('227548205599')).toBe('227548205599')
})
test('a totals-only workbook does not produce fabricated transactions', () => {
  const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([['Total cargas',90000]]),'Resumen')
  const f=path.join(dir,'ganamos_adminroyal_2026-03_SOLO-TOTALES.xlsx');XLSX.writeFile(w,f)
  const result=readFiles([f]);expect(result.transactions).toHaveLength(0)
  expect(result.reports[0].coverage).toBe('no_individual_transactions')
})
