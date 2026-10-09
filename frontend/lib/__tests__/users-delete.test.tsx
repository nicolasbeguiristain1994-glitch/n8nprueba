import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import UsersPage from '@/app/(protected)/users/page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id: 'self' }, permissions: { users: ['delete'] } }) }))
const target = { id: 'target', name: 'Operador de prueba', email: 'operator@example.test', role: 'operator', sectors: [], is_active: true }
const self = { ...target, id: 'self', name: 'Mi cuenta', email: 'admin@example.test', role: 'admin' }
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  // Each request needs its own response body.
  fetchMock.mockImplementation(async () => Response.json({ users: [self, target], pagination: { pages: 1 } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows a clear delete action, protects the current account and sends nothing on cancellation', async () => {
  render(<UsersPage />)
  expect(await screen.findByRole('button', { name: 'Eliminar usuario Mi cuenta' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Eliminar usuario Operador de prueba' }))
  const dialog = await screen.findByRole('dialog', { name: 'Eliminar usuario' })
  expect(within(dialog).getByText(target.email)).toBeInTheDocument()
  expect(within(dialog).getByText(/Se conservarán sus contactos/)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
  expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true)
})

it.each([200, 404])('confirms removal, disables repeat submission and handles an already removed user (%i)', async status => {
  let finish!: (response: Response) => void
  let deleted = false
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'DELETE') return new Promise<Response>(resolve => { finish = resolve })
    return Response.json({ users: deleted ? [self] : [self, target], pagination: { pages: 1 } })
  })
  render(<UsersPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'Eliminar usuario Operador de prueba' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Eliminar usuario' }))
  expect(await screen.findByRole('button', { name: 'Eliminando…' })).toBeDisabled()
  expect(fetchMock).toHaveBeenCalledWith('/api/users/target', { method: 'DELETE' })
  deleted = true; finish(Response.json({ ok: status === 200 }, { status }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Eliminar usuario Operador de prueba' })).not.toBeInTheDocument())
  expect(screen.getByRole('status')).toHaveTextContent('Usuario Operador de prueba eliminado')
})

it('keeps the user and shows the server error if deletion fails', async () => {
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'DELETE'
    ? Response.json({ error: 'No se puede eliminar el último administrador activo' }, { status: 400 })
    : Response.json({ users: [self, target], pagination: { pages: 1 } }))
  render(<UsersPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'Eliminar usuario Operador de prueba' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Eliminar usuario' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('último administrador activo')
  expect(screen.getByRole('button', { name: 'Eliminar usuario Operador de prueba', hidden: true })).toBeInTheDocument()
})
