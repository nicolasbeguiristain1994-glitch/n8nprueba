import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CampaignEffectivenessPanel } from '../CampaignEffectivenessPanel'
import type { CampaignEffectiveness, EffectiveRecipient } from '@/lib/campaign-effectiveness'

afterEach(cleanup)
const stats: Omit<CampaignEffectiveness, 'efectivos_detalle'> = {
  campaign_id: 'campaign', efectivos: 1, tasa_efectividad: '25.0', cargas_24h: 2,
  monto_cargado_24h: '1234.56', monto_apostado_24h: null, ventanas_abiertas: 2,
  sin_cuenta: 1, sin_hora_envio: 1, cargas_sin_hora: 3,
}
const recipient: EffectiveRecipient = {
  recipient_id: 'recipient', contact_id: 'contact', phone_number: '+5491100000001',
  cuentas_carga: [{ usuario: 'jugador_demo', plataforma: 'bet30' }, { usuario: 'jugador_zeus', plataforma: 'zeus' }],
  sent_at: '2026-10-01T15:00:00Z', primera_carga: '2026-10-01T16:00:00Z', cargas: 2, monto_cargado: '1234.56',
}

describe('Campaign effectiveness panel', () => {
  it('marks effective users, distinguishes deposits from unavailable bets, and explains incomplete evidence', () => {
    render(<CampaignEffectivenessPanel stats={stats} recipients={[recipient]} />)
    expect(screen.getByText('25.0%')).toBeInTheDocument()
    expect(screen.getByText('Efectivo')).toBeInTheDocument()
    expect(screen.getByText(recipient.phone_number)).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Usuario' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Plataforma' })).toBeInTheDocument()
    expect(screen.getByText('jugador_demo')).toBeInTheDocument()
    expect(screen.getByText('jugador_zeus')).toBeInTheDocument()
    expect(screen.getByText('Bet30')).toBeInTheDocument()
    expect(screen.getByText('Zeus')).toBeInTheDocument()
    expect(screen.getAllByText('$ 1.234,56')).toHaveLength(2)
    expect(screen.getByText('No disponible')).toBeInTheDocument()
    expect(screen.getByText(/resultado es provisional/)).toBeInTheDocument()
    expect(screen.getByText(/1 enviados sin cuenta/)).toBeInTheDocument()
    expect(screen.getByText(/1 enviados sin hora/)).toBeInTheDocument()
    expect(screen.getByText(/3 cargas.*quedan excluidas/)).toBeInTheDocument()
  })
  it('paginates the effective recipients and renders the empty state without inventing conversions', () => {
    const recipients = Array.from({ length: 21 }, (_, i) => ({ ...recipient, recipient_id: String(i), phone_number: `phone-${i}` }))
    const { rerender } = render(<CampaignEffectivenessPanel stats={stats} recipients={recipients} />)
    expect(screen.queryByText('phone-20')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(screen.getByText('phone-20')).toBeInTheDocument()
    expect(screen.queryByText('phone-0')).not.toBeInTheDocument()
    rerender(<CampaignEffectivenessPanel stats={{ ...stats, efectivos: 0, tasa_efectividad: null }} recipients={[]} />)
    expect(screen.getByText(/Todavía no hay usuarios efectivos/)).toBeInTheDocument()
    expect(screen.queryByText('Efectivo')).not.toBeInTheDocument()
  })
})
