import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'agent', role: 'operator', allowed_agents: ['royal'] } as { id: string; role: string; allowed_agents: string[] } | null,
  permissions: { contacts: ['read', 'create', 'update'] },
}))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => state }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn() }))
import { fetchJson } from '@/lib/fetchJson'
import { DEFAULT_CONTACT_VIEW } from '@/components/contacts/SavedContactViews'
import Contacts from '@/app/(protected)/contacts/page'

const contact = { id: 'fixture', first_name: 'Fixture', last_name: '', phone_number: '+5491100000001', panel: 'royal', status: 'active', opt_in: true, created_at: '2026-10-01', platforms: [] }
const calls = () => vi.mocked(fetchJson).mock.calls.filter(([url]) => String(url).startsWith('/api/contacts?'))
beforeEach(() => {
  localStorage.clear()
  state.user = { id: 'agent', role: 'operator', allowed_agents: ['royal'] }
  vi.mocked(fetchJson).mockResolvedValue({ contacts: [contact], total: 1, lists: [] })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('shows only granted names in contact filters and inline assignment', async () => {
  render(<Contacts />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'Filtrar contactos por agente' }))
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map(o => o.textContent)).toEqual(['Todos los agentes', 'royal'])
  await user.keyboard('{Escape}')
  for (const select of await screen.findAllByRole('combobox', { name: 'Editar Agente de Fixture' })) {
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['— sin agente', 'royal'])
  }
}, 15000)

it('discards a foreign agent in a saved view before querying or showing its badge', async () => {
  localStorage.setItem('crm:contact-views:agent', JSON.stringify([{ id: 'old', name: 'Vista anterior', state: { ...DEFAULT_CONTACT_VIEW, panel: 'betcoin', gaming: 'slots' } }]))
  render(<Contacts />)
  await waitFor(() => expect(calls()).toHaveLength(1))
  fireEvent.change(screen.getByLabelText('Vista de contactos'), { target: { value: 'old' } })
  await waitFor(() => expect(calls()).toHaveLength(2))
  const params = new URL(String(calls().at(-1)?.[0]), 'http://localhost').searchParams
  expect(params.get('panel')).toBe('')
  expect(params.get('gaming')).toBe('slots')
  expect(screen.getByLabelText('Filtros activos')).not.toHaveTextContent('betcoin')
}, 15000)

it('updates options and clears the active selection immediately when grants change', async () => {
  state.user!.allowed_agents = ['royal', 'bigwin']
  const view = render(<Contacts />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'Filtrar contactos por agente' }))
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'bigwin' }))
  expect(screen.getByLabelText('Filtros activos')).toHaveTextContent('Agente: bigwin')
  state.user = { ...state.user!, allowed_agents: ['royal'] }
  view.rerender(<Contacts />)
  expect(screen.queryByText('Agente: bigwin')).not.toBeInTheDocument()
  await user.click(screen.getByRole('combobox', { name: 'Filtrar contactos por agente' }))
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map(o => o.textContent)).toEqual(['Todos los agentes', 'royal'])
}, 15000)

it.each([
  ['loading', null, []],
  ['invalid scope', { id: 'agent', role: 'operator', allowed_agents: ['???'] }, []],
  ['admin', { id: 'admin', role: 'admin', allowed_agents: ['royal'] }, ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal', 'lasvegas']],
  ['multiple grants', { id: 'agent', role: 'viewer', allowed_agents: ['Royal', 'imperio'] }, ['royal', 'imperio']],
] as const)('respects %s when opening the agent picker', async (_, profile, options) => {
  state.user = profile ? { ...profile, allowed_agents: [...profile.allowed_agents] } : null
  render(<Contacts />)
  await userEvent.setup().click(screen.getByRole('combobox', { name: 'Filtrar contactos por agente' }))
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map(o => o.textContent)).toEqual(['Todos los agentes', ...options])
}, 15000)
