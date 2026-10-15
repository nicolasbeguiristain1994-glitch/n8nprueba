import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MovementRangeFilters } from '../InactivityRangeFilter'
import { MovementAge } from '../MovementAge'
import { EMPTY_INACTIVITY, inactivityParams } from '@/lib/inactivity-range'

afterEach(cleanup)
it('applies a last-movement range without the historical-period API flag', () => {
  const onChange=vi.fn()
  render(<MovementRangeFilters value={EMPTY_INACTIVITY} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:'Días desde el último movimiento'}))
  fireEvent.change(screen.getByLabelText('Más de'),{target:{value:'15'}})
  fireEvent.change(screen.getByLabelText('Hasta (inclusive)'),{target:{value:'60'}})
  fireEvent.click(screen.getByRole('button',{name:'Aplicar rango'}))
  expect(inactivityParams(onChange.mock.calls[0][0])).toEqual({inactividad_desde:'15',inactividad_hasta:'60'})
})
it('selects missing history separately and clears the bounds', () => {
  const onChange=vi.fn()
  render(<MovementRangeFilters value={{min:'15',max:'60'}} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:'Más de 15 y hasta 60 días sin movimientos'}))
  fireEvent.change(screen.getByLabelText('Historial de movimientos'),{target:{value:'missing'}})
  expect(screen.queryByLabelText('Más de')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Aplicar rango'}))
  expect(onChange).toHaveBeenCalledWith({min:'',max:'',mode:'missing'})
  expect(inactivityParams(onChange.mock.calls[0][0])).toEqual({movimiento_modo:'sin_historial'})
})
it('rejects an inverted range and can clear a missing-history selection', () => {
  const onChange=vi.fn()
  const {rerender}=render(<MovementRangeFilters value={{min:'15',max:'7'}} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:/Más de 15/}))
  expect(screen.getByRole('button',{name:'Aplicar rango'})).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Hasta debe ser mayor')
  fireEvent.click(screen.getByRole('button',{name:'Limpiar rango'}))
  rerender(<MovementRangeFilters value={{min:'',max:'',mode:'missing'}} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:'Sin movimientos registrados'}))
  fireEvent.click(screen.getByRole('button',{name:'Limpiar rango'}))
  expect(onChange).toHaveBeenLastCalledWith(EMPTY_INACTIVITY)
})
it('distinguishes missing history, today, calendar days and future source dates', () => {
  const {rerender}=render(<MovementAge days={null}/>)
  expect(screen.getByText('Sin movimientos registrados')).toBeInTheDocument()
  rerender(<MovementAge days={0} date="2026-10-15"/>)
  expect(screen.getByText('0 días')).toHaveAttribute('title',expect.stringContaining('15/10/2026'))
  rerender(<MovementAge days={1} date="2026-10-14"/>)
  expect(screen.getByText('1 día')).toBeInTheDocument()
  rerender(<MovementAge days={-1} date="2026-10-16"/>)
  expect(screen.getByText('Fecha futura')).toBeInTheDocument()
})
