import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardDateRangePicker } from '../DashboardDateRangePicker'
afterEach(cleanup)
const value={preset:'custom' as const,from:'2026-09-18',to:'2026-09-24'}
describe('custom date draft',()=>{
 it('allows clearing, typing and reversed intermediate dates without changing applied filters',()=>{
  const onChange=vi.fn();render(<DashboardDateRangePicker value={value} onChange={onChange}/>)
  fireEvent.change(screen.getByLabelText('Desde'),{target:{value:''}})
  expect(onChange).not.toHaveBeenCalled();expect(screen.getByLabelText('Desde')).toHaveValue('')
  expect(screen.getByRole('button',{name:'Aplicar fechas'})).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Desde'),{target:{value:'2026-10-01'}})
  expect(onChange).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Hasta'),{target:{value:'2026-10-15'}})
  fireEvent.click(screen.getByRole('button',{name:'Aplicar fechas'}))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({preset:'custom',from:'2026-10-01',to:'2026-10-15'})
 })
 it('rejects Desde == Hasta because Hasta 00:00 is excluded',()=>{
  const onChange=vi.fn();render(<DashboardDateRangePicker value={value} onChange={onChange}/>)
  fireEvent.change(screen.getByLabelText('Hasta'),{target:{value:'2026-09-18'}})
  expect(screen.getByRole('button',{name:'Aplicar fechas'})).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Desde debe ser anterior a Hasta')
  expect(onChange).not.toHaveBeenCalled()
 })
 it('shows midnight bounds and the included days before applying Aug 1 → Sep 1',()=>{
  const onChange=vi.fn();render(<DashboardDateRangePicker value={value} onChange={onChange}/>)
  expect(screen.getByLabelText('Hasta')).toHaveAccessibleDescription('00:00 (no incluye ese día)')
  fireEvent.change(screen.getByLabelText('Desde'),{target:{value:'2026-08-01'}})
  fireEvent.change(screen.getByLabelText('Hasta'),{target:{value:'2026-09-01'}})
  expect(screen.getByRole('status')).toHaveTextContent('01/08/2026 00:00 → 01/09/2026 00:00 (sin incluir 01/09/2026) · incluye 01/08/2026 al 31/08/2026')
  fireEvent.click(screen.getByRole('button',{name:'Aplicar fechas'}))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({preset:'custom',from:'2026-08-01',to:'2026-09-01'})
 })
 it('does not lose a draft on an unrelated rerender and cancels without requests',()=>{
  const onChange=vi.fn(),r=render(<DashboardDateRangePicker value={value} onChange={onChange}/>)
  fireEvent.change(screen.getByLabelText('Desde'),{target:{value:'2026-09-01'}})
  r.rerender(<DashboardDateRangePicker value={{...value}} onChange={onChange}/>)
  expect(screen.getByLabelText('Desde')).toHaveValue('2026-09-01')
  fireEvent.click(screen.getByRole('button',{name:'Cancelar'}))
  expect(screen.getByLabelText('Desde')).toHaveValue('2026-09-18');expect(onChange).not.toHaveBeenCalled()
 })
})
