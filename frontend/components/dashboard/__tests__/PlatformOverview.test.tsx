import { render, screen, cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PlatformOverview } from '../PlatformOverview'

afterEach(cleanup)
const props = { platform: 'consolidado' as const, agent: '', from: '2026-09-22', to: '2026-09-23', loading: false }
describe('PlatformOverview', () => {
  it('shows four platforms, exact cents, source dates and limitations', () => {
    render(<PlatformOverview {...props} activity={[{ platform: 'ganamos', agente: null, depositos: '100.25', retiros: '30.10', neto: '70.15', cuentas: 1, movimientos: 2, ultima_fecha: '2026-09-23' }]} />)
    for (const name of ['Zeus', 'Bet30', 'Ganamos', 'Argenbet']) expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    expect(screen.getAllByText('$ 70,15')).toHaveLength(2)
    expect(screen.getByText('23/09/2026')).toBeInTheDocument()
    expect(screen.getByText(/no confirma días completos/)).toBeInTheDocument()
    expect(screen.getByText(/adminimperio/)).toBeInTheDocument()
  })
  it('never converts an unavailable response into zero movements', () => {
    render(<PlatformOverview {...props} activity={null} />)
    expect(screen.getByText(/no disponible/)).toBeInTheDocument()
    expect(screen.queryByText('$ 0,00')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Total' })).not.toBeInTheDocument()
  })
  it('sums all four platform summaries, keeps provider cents and excludes agent detail', () => {
    const rows = [
      { platform: 'zeus' as const, depositos: '258646050.32', retiros: '165364027.97', bonos: '2947170.20', saldo_con_bonos: '96229192.55' },
      { platform: 'bet30' as const, depositos: '33730855.10', retiros: '21919586.75', bonos: '304180', saldo_con_bonos: '12115448.35' },
      { platform: 'ganamos' as const, depositos: '50245593', retiros: '25961577.20', bonos: '0', saldo_con_bonos: '24284015.80' },
      { platform: 'argenbet' as const, depositos: '22898554', retiros: '14920991.66717', bonos: '0', saldo_con_bonos: '7977562.33283' },
    ].map(row => ({ ...row, agente: null, neto: '0', cuentas: 2, movimientos: 3, ultima_fecha: null }))
    const activity = [...rows, { ...rows[0], agente: 'royal' }]
    const { rerender } = render(<PlatformOverview {...props} agent="royal" activity={activity} />)
    const total = within(screen.getByRole('article', { name: 'Total de las cuatro plataformas' }))
    for (const value of ['$ 365.521.052,42', '$ 228.166.183,58', '$ 3.251.350,20', '$ 140.606.219,03']) expect(total.getByText(value)).toBeInTheDocument()
    expect(total.getByText('12 movimientos · 8 cuentas con movimientos')).toBeInTheDocument()
    rerender(<PlatformOverview {...props} platform="zeus" activity={activity} />)
    expect(screen.queryByRole('heading', { name: 'Total' })).not.toBeInTheDocument()
  })
})
