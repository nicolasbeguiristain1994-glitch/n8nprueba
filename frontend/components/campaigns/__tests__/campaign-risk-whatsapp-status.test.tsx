import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CampaignRiskWhatsAppStatus } from '../CampaignRiskWhatsAppStatus'
import type { CampaignRiskWhatsAppAlertSummary } from '@/lib/campaign-risk-alerts'

afterEach(cleanup)
const alert = (status: CampaignRiskWhatsAppAlertSummary['status'], detail: string | null = null): CampaignRiskWhatsAppAlertSummary => ({
  id: 'alert', incidentId: 'incident', status, detail, updatedAt: '2026-10-19T15:00:00Z',
})

describe('WhatsApp operational alert visibility', () => {
  it('distinguishes provider acceptance from confirmed delivery and does not offer a resend', () => {
    render(<CampaignRiskWhatsAppStatus alerts={[alert('sent')]} unavailable={false} />)
    expect(screen.getByText('Aceptada por WhatsApp')).toBeInTheDocument()
    expect(screen.getByText('La entrega al teléfono aún no está confirmada.')).toBeInTheDocument()
    expect(screen.queryByText('Entregada')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('keeps an ambiguous outcome explicit without suggesting an automatic retry', () => {
    render(<CampaignRiskWhatsAppStatus alerts={[alert('uncertain')]} unavailable={false} />)
    expect(screen.getByText('Sin confirmación')).toBeInTheDocument()
    expect(screen.getByText('No se reenvía automáticamente para evitar duplicados.')).toBeInTheDocument()
    expect(screen.queryByText('No enviada')).not.toBeInTheDocument()
  })
  it('explains an unavailable template separately from the campaign hold', () => {
    render(<CampaignRiskWhatsAppStatus alerts={[alert('blocked', 'La plantilla de alertas todavía no está aprobada.')]} unavailable={false} />)
    expect(screen.getByText('En espera')).toBeInTheDocument()
    expect(screen.getByText('La plantilla de alertas todavía no está aprobada.')).toBeInTheDocument()
    expect(screen.getByText(/El envío de esta alerta no reanuda la campaña/)).toBeInTheDocument()
  })
  it('does not mistake an unavailable status query for no alert or a successful send', () => {
    render(<CampaignRiskWhatsAppStatus alerts={[]} unavailable />)
    expect(screen.getByText(/No se pudo consultar el envío de la alerta/)).toBeInTheDocument()
    expect(screen.queryByText(/Todavía no hay envíos/)).not.toBeInTheDocument()
    expect(screen.queryByText('Aceptada por WhatsApp')).not.toBeInTheDocument()
  })
})
