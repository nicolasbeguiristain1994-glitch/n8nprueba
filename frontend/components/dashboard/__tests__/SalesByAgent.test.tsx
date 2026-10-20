import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SalesByAgent } from '../SalesByAgent'
import type { AgentSalesComparison } from '@/lib/dashboard-casino'
afterEach(cleanup)
const comparison: AgentSalesComparison = {previous:{from:'2026-08-01',to:'2026-08-31'},rows:[
  {agente:'royal',amount:'150',previous_amount:'100',difference:'50',change_percentage:'50'},
  {agente:'bigwin',amount:'50',previous_amount:'100',difference:'-50',change_percentage:'-50'},
  {agente:'farabet',amount:'25',previous_amount:'0',difference:'25',change_percentage:null},
  {agente:'ofizeus',amount:'0',previous_amount:'0',difference:'0',change_percentage:'0'},
]}
const props={comparison,loading:false,platform:'consolidado' as const,agent:'',dateRange:{preset:'custom' as const,from:'2026-09-01',to:'2026-10-01'}}
it('shows sales sorted by amount and small signed changes with red/green/neutral colors',()=>{
  render(<SalesByAgent {...props} />)
  expect(screen.getByText('$ 225,00')).toBeInTheDocument()
  expect(screen.getByText('Depósitos sin bonos · Todas las plataformas')).toBeInTheDocument()
  expect(screen.getByText(/01\/09\/2026 al 30\/09\/2026.*01\/08\/2026 al 31\/08\/2026/)).toBeInTheDocument()
  expect(screen.getByText('+50%').closest('.text-emerald-700')).toBeInTheDocument()
  expect(screen.getByText('−50%').closest('.text-rose-700')).toBeInTheDocument()
  expect(screen.getByText('0%').closest('div')).toHaveClass('text-muted-foreground')
  expect(screen.getByText('Sin base anterior')).toBeInTheDocument()
  expect(screen.queryByText('+100%')).not.toBeInTheDocument()
  const names=screen.getAllByRole('term').map(el=>el.textContent)
  expect(names).toEqual(['royal','bigwin','farabet','ofizeus'])
  expect(within(screen.getByText('bigwin').parentElement!).getByText('Anterior: $ 100,00')).toBeInTheDocument()
})
it('only displays with all agents, and retains the selected platform',()=>{
  const {rerender}=render(<SalesByAgent {...props} agent="royal" />)
  expect(screen.queryByRole('region',{name:'Ventas por agente'})).not.toBeInTheDocument()
  rerender(<SalesByAgent {...props} platform="zeus" />)
  expect(screen.getByText('Depósitos sin bonos · Zeus')).toBeInTheDocument()
})
it('distinguishes loading, unavailable and genuine zero sales',()=>{
  const {rerender}=render(<SalesByAgent {...props} comparison={null} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Consultando ventas')
  rerender(<SalesByAgent {...props} comparison={null} />)
  expect(screen.getByText(/Comparativa no disponible/)).toBeInTheDocument()
  expect(screen.queryByText('$ 0,00')).not.toBeInTheDocument()
  rerender(<SalesByAgent {...props} comparison={{...comparison,rows:[]}} />)
  expect(screen.getByText('$ 0,00')).toBeInTheDocument()
})
