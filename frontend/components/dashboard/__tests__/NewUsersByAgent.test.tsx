import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NewUsersByAgent } from '../NewUsersByAgent'
import type { CasinoAgente } from '@/app/api/dashboard/casino/route'

afterEach(cleanup)
const props = { platform: 'consolidado' as const, agent: '', dateRange: { preset: 'custom' as const, from: '2026-09-01', to: '2026-10-01' }, loading: false }
const row = (agente: string, nuevos_mes: number) => ({ agente, nuevos_mes, total: 500, activos_mes: 200 } as CasinoAgente)

it('counts first deposits, retains zero agents, and replaces the breakdown with the filtered response', () => {
  const rows = [row('royal', 3), row('ofizeus', 1), row('bigwin', 0)]
  const { rerender } = render(<NewUsersByAgent {...props} agentes={rows} />)
  expect(screen.getByText('4')).toBeInTheDocument()
  expect(screen.getByText('75% del total')).toBeInTheDocument()
  expect(screen.getByText('bigwin')).toBeInTheDocument()
  expect(screen.getByText(/Primer depósito registrado/)).toBeInTheDocument()
  expect(screen.queryByText('500')).not.toBeInTheDocument()
  rerender(<NewUsersByAgent {...props} platform="bet30" agent="royal" agentes={[row('royal', 2)]} />)
  expect(screen.queryByText('ofizeus')).not.toBeInTheDocument()
  expect(screen.getByText('100% del total')).toBeInTheDocument()
  expect(screen.getByText(/Bet30 · royal/)).toBeInTheDocument()
})

it('distinguishes unavailable and loading data from a real zero result', () => {
  const { rerender } = render(<NewUsersByAgent {...props} agentes={null} />)
  expect(screen.getByText(/Usuarios nuevos no disponibles/)).toBeInTheDocument()
  expect(screen.queryByText('0')).not.toBeInTheDocument()
  rerender(<NewUsersByAgent {...props} agentes={null} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Consultando usuarios nuevos')
  rerender(<NewUsersByAgent {...props} agentes={[]} />)
  expect(screen.getByText('0')).toBeInTheDocument()
  expect(screen.getByText(/No hay primeros depósitos/)).toBeInTheDocument()
})
