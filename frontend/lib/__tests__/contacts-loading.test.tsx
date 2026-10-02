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
