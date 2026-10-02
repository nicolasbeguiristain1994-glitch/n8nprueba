import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn() }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { role: 'admin' }, permissions: { contacts: ['read', 'create', 'delete'] } }) }))
import { fetchJson } from '@/lib/fetchJson'
import { deleteContacts } from '@/lib/delete-contacts'
import Contacts from '@/app/(protected)/contacts/page'
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
const contacts = ids.map((id, i) => ({ id, first_name: `Fixture ${i + 1}`, phone_number: `+549110000000${i}`, last_name: '', status: 'active', opt_in: true, created_at: '2026-10-01', segment: 'bajo', platforms: ['otros'] }))
const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(fetchJson).mockImplementation(async () => ({ contacts, total: contacts.length, lists: [] }) as never)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })
async function selectAndConfirm() {
  render(<Contacts />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todas las filas de esta página' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Eliminar (2)' })[0])
  const dialog = screen.getByRole('dialog', { name: 'Eliminar contactos' })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar' })) })
  return dialog
}
it('keeps failures visible and selected, retries only failed contacts and closes after success', async () => {
  fetchMock.mockImplementation(async (url: string) => url.endsWith(ids[0])
    ? Response.json({ ok: true }) : Response.json({ error: 'No se pudo eliminar por un bloqueo temporal.' }, { status: 503 }))
  const dialog = await selectAndConfirm()
  expect(within(dialog).getByRole('alert')).toHaveTextContent('1 eliminados. No se pudieron eliminar 1 contactos.')
  expect(within(dialog).getByRole('alert')).toHaveTextContent('bloqueo temporal')
  expect(screen.queryByText('Fixture 1')).not.toBeInTheDocument()
  expect(within(screen.getByRole('grid', { hidden: true })).getByRole('checkbox', { name: 'Seleccionar fila', hidden: true })).toBeChecked()
  fetchMock.mockResolvedValue(Response.json({ ok: true }))
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar' })) })
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(fetchMock.mock.calls[2][0]).toBe(`/api/contacts/${ids[1]}`)
  expect(screen.queryByRole('dialog', { name: 'Eliminar contactos' })).not.toBeInTheDocument()
  expect(screen.queryByText('Fixture 2')).not.toBeInTheDocument()
})
it('reports a complete connection failure instead of silently closing confirmation', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  const dialog = await selectAndConfirm()
  expect(within(dialog).getByRole('alert')).toHaveTextContent('0 eliminados')
  expect(within(dialog).getByRole('alert')).toHaveTextContent('No se pudo conectar')
  expect(within(screen.getByRole('grid', { hidden: true })).getAllByRole('checkbox', { name: 'Seleccionar fila', hidden: true }).every(el => el.getAttribute('aria-checked') === 'true')).toBe(true)
})
it('limits concurrent deletes and accepts already deleted contacts when retrying', async () => {
  let active = 0, peak = 0
  fetchMock.mockImplementation(async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return Response.json({ error: 'Not found' }, { status: 404 })
  })
  const result = await deleteContacts(['1', '2', '3', '4', '5', '1'])
  expect(peak).toBe(3)
  expect(result.failed).toEqual([])
  expect(result.deleted).toHaveLength(5)
  expect(fetchMock).toHaveBeenCalledTimes(5)
})
it.each([401, 403, 500])('shows an actionable error for HTTP %i without removing the selection', async status => {
  fetchMock.mockResolvedValue(new Response('not json', { status }))
  const result = await deleteContacts(ids)
  expect(result.deleted).toHaveLength(0)
  expect(result.failed).toHaveLength(2)
  expect(result.failed[0].error).toMatch(status === 401 ? /sesión/ : status === 403 ? /permiso/ : /500/)
})
