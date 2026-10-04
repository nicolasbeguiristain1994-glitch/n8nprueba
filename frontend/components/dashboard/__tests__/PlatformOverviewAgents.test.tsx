import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SYNC_PLATFORMS, type SyncPlatform } from '@/lib/casino-agents'
import type { PlatformActivity } from '@/lib/dashboard-overview'
import { PlatformOverview, UNCONFIGURED_ACCOUNT } from '../PlatformOverview'
import { OPERATOR_ACCOUNTS } from '@/lib/__tests__/fixtures/operator-accounts'

afterEach(cleanup)
const LABELS: Record<SyncPlatform, string> = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }
const props = { platform: 'consolidado' as const, from: '2026-08-01', to: '2026-08-31', loading: false }
const card = (p: SyncPlatform) => within(screen.getByRole('table', { name: 'Comparación de movimientos por plataforma' })).getByRole('rowheader', { name: new RegExp('^' + LABELS[p]) }).closest('tr') as HTMLElement
const table = () => screen.getByRole('table', { name: 'Movimientos por agente del período y última fecha disponible del historial' })
const activityRow = (platform: SyncPlatform, agente: string | null, depositos = '0', movimientos = 0): PlatformActivity => ({
  platform, agente, depositos, retiros: '0', neto: depositos, bonos: '0', saldo_con_bonos: depositos,
  movimientos, cuentas: movimientos ? 1 : 0, ultima_fecha: movimientos ? '2026-08-20' : null,
})

describe('PlatformOverview — every operator on every platform', () => {
  describe.each(Object.keys(OPERATOR_ACCOUNTS))('operator %s without movements', op => {
    it.each(SYNC_PLATFORMS)('%s shows its configured account or states that none is configured', p => {
      render(<PlatformOverview {...props} agent={op} activity={[]} />)
      const accounts = OPERATOR_ACCOUNTS[op][p]
      const rows = within(table()).getAllByRole('row').filter(r => within(r).queryByText(LABELS[p]))
      if (accounts.length) {
        expect(within(card(p)).queryByText(new RegExp(UNCONFIGURED_ACCOUNT))).not.toBeInTheDocument()
        expect(within(card(p)).getByText(/No hay movimientos registrados/)).toBeInTheDocument()
        expect(rows.map(r => within(r).getByRole('rowheader').textContent)).toEqual(accounts)
      } else {
        expect(within(card(p)).getByText(`${UNCONFIGURED_ACCOUNT}.`)).toBeInTheDocument()
        expect(within(card(p)).queryByText(/No hay movimientos registrados/)).not.toBeInTheDocument()
        expect(within(card(p)).queryByText('$ 0,00')).not.toBeInTheDocument()
        expect(within(card(p)).getAllByText('—')).toHaveLength(4)
        expect(rows).toHaveLength(1)
        expect(within(rows[0]).getByText(UNCONFIGURED_ACCOUNT)).toBeInTheDocument()
      }
    })
  })

  it('farabet: configured on Zeus, Bet30 and Ganamos; Argenbet states no configured account', () => {
    render(<PlatformOverview {...props} agent="farabet" activity={[
      activityRow('zeus', null, '1500.50', 3), activityRow('zeus', 'farabet', '1500.50', 3),
      activityRow('bet30', null, '200', 1), activityRow('bet30', 'btcdos', '200', 1),
    ]} />)
    expect(within(card('zeus')).getAllByText('$ 1.500,50').length).toBeGreaterThan(0)
    expect(within(card('bet30')).getAllByText('$ 200,00').length).toBeGreaterThan(0)
    expect(within(card('ganamos')).getByText(/No hay movimientos registrados/)).toBeInTheDocument()
    expect(within(card('argenbet')).getByText(`${UNCONFIGURED_ACCOUNT}.`)).toBeInTheDocument()
  })

  it('never hides an observed account on a platform without configuration', () => {
    render(<PlatformOverview {...props} agent="farabet" activity={[
      activityRow('argenbet', null, '42.10', 2), activityRow('argenbet', 'farabet', '42.10', 2),
    ]} />)
    expect(within(card('argenbet')).queryByText(`${UNCONFIGURED_ACCOUNT}.`)).not.toBeInTheDocument()
    expect(within(card('argenbet')).getAllByText('$ 42,10').length).toBeGreaterThan(0)
    expect(within(card('argenbet')).getByText(/no tiene cuenta configurada/)).toBeInTheDocument()
    const row = within(table()).getAllByRole('row').find(r => within(r).queryByText('Argenbet'))!
    expect(within(row).getByRole('rowheader')).toHaveTextContent('farabet')
    expect(within(row).getAllByText('$ 42,10')).toHaveLength(2)
  })

  it('matches stored names ignoring case and spaces instead of adding a false zero row', () => {
    render(<PlatformOverview {...props} agent="farabet" activity={[
      activityRow('ganamos', null, '10', 1), activityRow('ganamos', 'AdminFara ', '10', 1),
    ]} />)
    const rows = within(table()).getAllByRole('row').filter(r => within(r).queryByText('Ganamos'))
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByRole('rowheader')).toHaveTextContent('AdminFara')
    expect(within(rows[0]).getAllByText('$ 10,00')).toHaveLength(2)
  })

  it('shows every configured account when no agent is selected', () => {
    render(<PlatformOverview {...props} agent="" activity={[]} />)
    expect(screen.queryByText(new RegExp(UNCONFIGURED_ACCOUNT))).not.toBeInTheDocument()
    const total = SYNC_PLATFORMS.reduce((n, p) => n + Object.values(OPERATOR_ACCOUNTS).reduce((m, a) => m + a[p].length, 0), 0)
    expect(screen.getByText(`Ver movimientos y última fecha de cada agente (${total})`)).toBeInTheDocument()
  })

  it('a single platform with its own raw agent never reports a missing account', () => {
    render(<PlatformOverview {...props} platform="bet30" agent="btcdos" activity={[]} />)
    expect(screen.queryByText(new RegExp(UNCONFIGURED_ACCOUNT))).not.toBeInTheDocument()
    expect(within(table()).getByRole('rowheader')).toHaveTextContent('btcdos')
  })
})
