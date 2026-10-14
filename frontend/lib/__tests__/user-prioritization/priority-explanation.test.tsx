import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe,it,expect } from 'vitest'
import { PriorityExplanationDialog } from '@/components/priorities/PriorityExplanationDialog'

describe('explanation of commercial priority',()=>{
 it('shows money, frequency, dates, quality and a separate relative ranking',()=>{
  render(<PriorityExplanationDialog onClose={()=>{}} contact={{name:'Ejemplo',level:'Bajo',score:50,daysInactive:30,explanation:{valueScore:10,urgencyScore:40,calculatedAt:'2026-10-14T07:00:00Z',manualLevel:false,profile:{monthly_average:30000,amount:150000,deposits:22,withdrawals:1,active_months:5,first_date:'2026-05-11',last_date:'2026-09-30',estimated:false,partial_history:false,as_of:'2026-10-14',calculated_at:'2026-10-14T07:00:00Z',amount_90d:25000,deposits_90d:5,amount_30d:3000,deposits_30d:1,accounts:[]},ranking:{percentile:52.5,net:125000,calculatedAt:'2026-09-30T23:00:00Z',platform:'zeus',agent:'fixture-agent',status:'stale'}}}} />)
  expect(screen.getByText('50 puntos = 10 de valor + 40 de urgencia')).toBeInTheDocument()
  expect(screen.getByText('Últimos 30 días')).toBeInTheDocument()
  expect(screen.getByText('Últimos 90 días')).toBeInTheDocument()
  expect(screen.getByText(/52,5 dentro de fixture-agent \/ zeus · Vencido/)).toBeInTheDocument()
  expect(screen.getByText(/no cambia el nivel comercial/)).toBeInTheDocument()
 })
})
