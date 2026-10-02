import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationItem } from '../ConversationItem'
import { ConversationHeader } from '../ConversationHeader'
import { ConversationFilters } from '../ConversationFilters'
import type { Conv, Segment } from '@/lib/scoring/conversation-scoring'

afterEach(cleanup)
const base: Conv = { phone_number: '5491100000001', first_name: 'Ana', contact_id: 'contact', last_message: 'Gracias', last_direction: 'inbound', last_status: 'received', last_at: '2026-10-01T18:00:00Z' }

describe('Conversation campaign and level labels', () => {
  it.each<[Segment, string]>([
    ['super_vip', 'Super VIP'], ['vip_alto', 'VIP alto'], ['vip_medio', 'VIP medio'],
    ['vip', 'VIP bajo'], ['medio', 'Medio'], ['bajo', 'Bajo'], [null, 'Sin nivel'],
    ['casual', 'Casual'], ['regular', 'Regular'], ['whale', 'Whale'],
  ])('shows %s consistently in the chat list and header', (segment, label) => {
    const conv = { ...base, segment }
    render(<><ConversationItem conv={conv} isSelected={false} onClick={vi.fn()} /><ConversationHeader phone={conv.phone_number} conv={conv} /></>)
    expect(screen.getAllByText(label)).toHaveLength(2)
    expect(screen.getAllByText('Sin campaña')).toHaveLength(2)
  })

  it('shows the selected historical campaign and the count of additional campaigns', () => {
    render(<ConversationItem conv={{ ...base, campaigns: [
      { id: 'recent', name: 'Extra Royal', last_sent_at: '2026-10-01' },
      { id: 'older', name: 'Bono septiembre', last_sent_at: '2026-09-01' },
    ] }} selectedCampaign="older" isSelected={false} onClick={vi.fn()} />)
    expect(screen.getByText('Bono septiembre')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByTitle('Campañas: Extra Royal · Bono septiembre')).toBeInTheDocument()
  })

  it('offers independent campaign and exact level filters', () => {
    const onCampaign = vi.fn(), onLevel = vi.fn()
    render(<ConversationFilters convs={[]} search="" filter="all" campaign="all" level="all"
      campaigns={[{ id: 'a', name: 'Extra Royal', count: 205 }]} onCampaign={onCampaign} onLevel={onLevel}
      dateFrom="" dateTo="" followUpOnly={false} realtimeStatus="connected" notifPermission="default"
      searchRef={createRef()} onSearch={vi.fn()} onFilter={vi.fn()} onDateFrom={vi.fn()} onDateTo={vi.fn()} onFollowUp={vi.fn()} onRequestNotif={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Filtrar por campaña'), { target: { value: 'a' } })
    fireEvent.change(screen.getByLabelText('Filtrar por nivel'), { target: { value: 'vip_medio' } })
    expect(onCampaign).toHaveBeenCalledWith('a')
    expect(onLevel).toHaveBeenCalledWith('vip_medio')
    expect(screen.getByRole('option', { name: 'Extra Royal (205)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Bajo' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Sin nivel' })).toBeInTheDocument()
  })
})
