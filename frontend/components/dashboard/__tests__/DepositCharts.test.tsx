import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DepositCharts } from '../DepositCharts'
import { depositAnalytics } from '@/lib/dashboard-deposits'
vi.mock('recharts', () => ({ ResponsiveContainer: ({children}: {children: React.ReactNode}) => <div>{children}</div>, BarChart: () => <div />, Bar: () => null, CartesianGrid: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null }))
afterEach(cleanup)
describe('deposit charts', () => {
 it('shows separate unknown-hour counts and switches to amounts', () => {
  const data = depositAnalytics([{dimension:'total',key:null,count:2,amount:'125.25',percentage:null},{dimension:'hour',key:null,count:1,amount:'25.25',percentage:null}], 'consolidado')
  render(<DepositCharts data={data} loading={false} />)
  const hourly = screen.getByRole('group', {name:'Métrica de Depósitos por hora del día'})
  expect(within(hourly).getByRole('button',{name:'Cantidad'})).toHaveAttribute('aria-pressed','true')
  fireEvent.click(within(hourly).getByRole('button',{name:'Importe'}))
  expect(screen.getByRole('img',{name:/Depósitos por hora del día: importe/})).toBeInTheDocument()
  expect(screen.getByText('Depósitos sin hora registrada')).toBeInTheDocument()
  expect(screen.getByText(/no se asignan a las 00:00/)).toBeInTheDocument()
 })
 it('distinguishes unavailable data from an empty period', () => {
  const r=render(<DepositCharts data={null} loading={false} />)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.queryByText(/No hay depósitos registrados/)).not.toBeInTheDocument()
  r.rerender(<DepositCharts data={depositAnalytics([], 'consolidado')} loading={false} />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText(/No hay depósitos registrados/)).toBeInTheDocument()
 })
})
