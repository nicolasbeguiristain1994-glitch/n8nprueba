import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn() }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { role: 'admin' }, permissions: { contacts: ['read', 'create'] } }) }))
import { fetchJson } from '@/lib/fetchJson'
import Contacts from '@/app/(protected)/contacts/page'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
it('loads immediately, groups fast typing, cancels stale requests and refreshes immediately on demand', async () => {
  vi.useFakeTimers()
  vi.mocked(fetchJson).mockResolvedValue({ contacts: [], total: 0, lists: [] })
  const { unmount } = render(<Contacts />)
  const contacts = () => vi.mocked(fetchJson).mock.calls.filter(([url]) => String(url).startsWith('/api/contacts?'))
  await act(async () => {})
  expect(contacts()).toHaveLength(1)
  const input = screen.getByPlaceholderText('Buscar por nombre o teléfono…')
  for (const value of ['a', 'al', 'ali', 'alic', 'alice']) fireEvent.change(input, { target: { value } })
  expect(contacts()).toHaveLength(1)
  expect(contacts()[0][1]?.signal?.aborted).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(contacts()).toHaveLength(2)
  expect(String(contacts()[1][0])).toContain('q=alice')
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar contactos' }))
  expect(contacts()).toHaveLength(3)
  await act(async () => {})
  unmount()
  expect(contacts()[2][1]?.signal?.aborted).toBe(true)
})

it('shows the exact page before history finishes and ignores history from an older search', async () => {
  vi.useFakeTimers()
  const pending: ((value: unknown) => void)[] = []
  const first = { id:'11111111-1111-4111-8111-111111111111', first_name:'Primero', phone_number:'+5491111111111' }
  const second = { id:'22222222-2222-4222-8222-222222222222', first_name:'Segundo', phone_number:'+5491111111112' }
  vi.mocked(fetchJson).mockImplementation(async input => {
    const url = String(input)
    if (url.startsWith('/api/contacts/history?')) return new Promise(resolve => pending.push(resolve))
    if (url.startsWith('/api/contacts?')) return {contacts:[url.includes('q=Segundo') ? second : first],total:1}
    return {lists:[]}
  })
  render(<Contacts />)
  await act(async () => {})
  expect(screen.getAllByText('Primero').length).toBeGreaterThan(0)
  expect(screen.getAllByLabelText('Cargando movimientos').length).toBeGreaterThan(0)
  expect(screen.queryByText('Sin movimientos registrados')).not.toBeInTheDocument()
  fireEvent.change(screen.getByPlaceholderText('Buscar por nombre o teléfono…'),{target:{value:'Segundo'}})
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(pending).toHaveLength(2)
  await act(async () => { pending[0]({history:[{id:first.id,days_since_last_movement:99}]}) })
  expect(screen.queryByText('Primero')).not.toBeInTheDocument()
  expect(screen.queryByText('99 días')).not.toBeInTheDocument()
  await act(async () => { pending[1]({history:[{id:second.id,days_since_last_movement:2,last_movement_date:'2026-10-13',days_since_last_broadcast:null,last_broadcast_at:null}]}) })
  expect(screen.getAllByText('2 días').length).toBeGreaterThan(0)
  expect(screen.queryByLabelText('Cargando movimientos')).not.toBeInTheDocument()
})

it('keeps usable results and distinguishes failed history from missing history', async () => {
  vi.mocked(fetchJson).mockImplementation(async input => {
    const url = String(input)
    if (url.startsWith('/api/contacts/history?')) throw new Error('history timeout')
    if (url.startsWith('/api/contacts?')) return {contacts:[{id:'11111111-1111-4111-8111-111111111111',first_name:'Visible',phone_number:'+5491111111111'}],total:1}
    return {lists:[]}
  })
  render(<Contacts />)
  await act(async () => {})
  expect(screen.getAllByText('Visible').length).toBeGreaterThan(0)
  expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0)
  expect(screen.queryByText('Sin movimientos registrados')).not.toBeInTheDocument()
  expect(screen.queryByText('Sin difusión')).not.toBeInTheDocument()
})
