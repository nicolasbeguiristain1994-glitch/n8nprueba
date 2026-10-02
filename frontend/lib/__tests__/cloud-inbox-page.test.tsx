import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, it, expect, vi } from 'vitest'

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params }))
import Page from '@/app/(protected)/lines/cloud-inbox/page'

const lines = [
  { id: 'l1', display_name: 'Línea Uno', cloud_phone_number_id: 'pn-1' },
  { id: 'l2', display_name: 'Línea Dos', cloud_phone_number_id: 'pn/2' },
  { id: 'l3', display_name: 'Evolution', cloud_phone_number_id: null },
]
let fetchSpy: ReturnType<typeof vi.fn>
function mockApi(available = lines) {
  fetchSpy = vi.fn(async (url: string) => {
    if (url === '/api/lines') return new Response(JSON.stringify({ lines: available }), { status: 200 })
    if (url.startsWith('/api/cloud/inbox')) return new Response(JSON.stringify(url.includes('&contact=') ? { messages: [] } : { conversations: [] }), { status: 200 })
    return new Response('{}', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchSpy)
}
const inboxCalls = () => fetchSpy.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/cloud/inbox'))
const assertNoSend = () => {
  for (const [url, init] of fetchSpy.mock.calls) {
    expect(String(url)).not.toContain('/api/cloud/messages')
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
  }
}

beforeEach(() => { nav.params = new URLSearchParams() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('selects the requested line when it is accessible and only loads history', async () => {
  nav.params = new URLSearchParams({ phoneNumberId: 'pn/2' })
  mockApi()
  render(<Page />)
  await waitFor(() => expect(inboxCalls()).toEqual(['/api/cloud/inbox?phoneNumberId=pn%2F2']))
  expect(screen.getByRole('combobox')).toHaveValue('pn/2')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  assertNoSend()
})

it('shows a not-accessible message and does not select another line for an unknown ID', async () => {
  nav.params = new URLSearchParams({ phoneNumberId: 'pn-ajeno' })
  mockApi([lines[0]])
  render(<Page />)
  expect(await screen.findByRole('alert')).toHaveTextContent(/no tenés acceso/)
  expect(screen.getByRole('combobox')).toHaveValue('')
  expect(inboxCalls()).toEqual([])
  assertNoSend()
})

it('auto-selects the only accessible line when no line is requested', async () => {
  mockApi([lines[0], lines[2]])
  render(<Page />)
  await waitFor(() => expect(inboxCalls()).toEqual(['/api/cloud/inbox?phoneNumberId=pn-1']))
  expect(screen.getByRole('combobox')).toHaveValue('pn-1')
  assertNoSend()
})

it('does not auto-select when several lines are accessible and none is requested', async () => {
  mockApi()
  render(<Page />)
  expect(await screen.findByRole('option', { name: 'Línea Dos' })).toBeInTheDocument()
  expect(screen.getByRole('combobox')).toHaveValue('')
  expect(inboxCalls()).toEqual([])
  assertNoSend()
})

it('clears the previous line and recipient while validating a changed URL, without falling back for a denied line', async () => {
  nav.params = new URLSearchParams({ phoneNumberId: 'pn-1' })
  mockApi()
  const { rerender } = render(<Page />)
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('pn-1'))
  fireEvent.change(screen.getByLabelText('Destinatario autorizado'), { target: { value: '+5491100000000' } })
  await waitFor(() => expect(inboxCalls()).toHaveLength(2))
  fireEvent.change(screen.getByLabelText('Mensaje'), { target: { value: 'Borrador de la línea anterior' } })
  // A failed history request must also be cleared before the new line is loaded.
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Error de la línea anterior' }), { status: 500 }))
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar mensajes y estados' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Error de la línea anterior')

  let resolveLines!: (r: Response) => void
  fetchSpy.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveLines = resolve }))
  nav.params = new URLSearchParams({ phoneNumberId: 'pn-ajeno' })
  rerender(<Page />)
  expect(screen.getByRole('combobox')).toHaveValue('')
  expect(screen.getByLabelText('Destinatario autorizado')).toHaveValue('')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Enviar mensaje' })).not.toBeInTheDocument()
  const previousCalls = inboxCalls()

  await act(async () => { resolveLines(new Response(JSON.stringify({ lines: [lines[0]] }), { status: 200 })) })
  expect(await screen.findByRole('alert')).toHaveTextContent(/no tenés acceso/)
  expect(screen.getByRole('combobox')).toHaveValue('')
  expect(inboxCalls()).toEqual(previousCalls)

  fetchSpy.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveLines = resolve }))
  nav.params = new URLSearchParams({ phoneNumberId: 'pn/2' })
  rerender(<Page />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await act(async () => { resolveLines(new Response(JSON.stringify({ lines }), { status: 200 })) })
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('pn/2'))
  expect(inboxCalls().at(-1)).toBe('/api/cloud/inbox?phoneNumberId=pn%2F2')
  expect(screen.getByLabelText('Destinatario autorizado')).toHaveValue('')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  assertNoSend()
})

it('opens a different requested line without carrying its previous contact, messages or conversations', async () => {
  nav.params = new URLSearchParams({ phoneNumberId: 'pn-1' })
  mockApi()
  const previousConversation = { id: 'c1', contact_phone: '+5491100000000', last_message_preview: 'Conversación anterior' }
  fetchSpy.mockImplementation(async (url: string) => {
    if (url === '/api/lines') return new Response(JSON.stringify({ lines }))
    if (url.includes('contact=')) return new Response(JSON.stringify({ messages: [{ id: 'm1', direction: 'inbound', status: 'received', message_type: 'text', content: { text: { body: 'Mensaje anterior' } }, sent_at: '2026-09-28T12:00:00Z' }] }))
    return new Response(JSON.stringify({ conversations: url.includes('pn-1') ? [previousConversation] : [] }))
  })
  const { rerender } = render(<Page />)
  fireEvent.click(await screen.findByRole('button', { name: /Conversación anterior/ }))
  expect(await screen.findByText('Mensaje anterior')).toBeInTheDocument()

  nav.params = new URLSearchParams({ phoneNumberId: 'pn/2' })
  rerender(<Page />)
  expect(screen.queryByText('Mensaje anterior')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Conversación anterior/ })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Destinatario autorizado')).toHaveValue('')
  await waitFor(() => expect(inboxCalls().at(-1)).toBe('/api/cloud/inbox?phoneNumberId=pn%2F2'))
  expect(inboxCalls().some(url => url.includes('pn%2F2') && url.includes('contact='))).toBe(false)
  assertNoSend()
})

it('ignores an old conversation response that completes after switching the requested line', async () => {
  nav.params = new URLSearchParams({ phoneNumberId: 'pn-1' })
  mockApi()
  let resolveHistory!: (r: Response) => void
  let oldSignal: AbortSignal | undefined
  fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/lines') return new Response(JSON.stringify({ lines }))
    if (url.includes('pn-1')) {
      oldSignal = init?.signal ?? undefined
      return new Promise<Response>(resolve => { resolveHistory = resolve })
    }
    return new Response(JSON.stringify({ conversations: [] }))
  })
  const { rerender } = render(<Page />)
  await waitFor(() => expect(inboxCalls()).toHaveLength(1))
  nav.params = new URLSearchParams({ phoneNumberId: 'pn/2' })
  rerender(<Page />)
  await waitFor(() => expect(inboxCalls()).toHaveLength(2))
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => { resolveHistory(new Response(JSON.stringify({ conversations: [{ id: 'old', contact_phone: '+5491100000000', last_message_preview: 'Respuesta tardía anterior' }] }))) })
  expect(screen.queryByRole('button', { name: /Respuesta tardía anterior/ })).not.toBeInTheDocument()
  assertNoSend()
})

it('ignores the lines response after unmount', async () => {
  let resolve: (r: Response) => void = () => {}
  let signal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise<Response>(r => { resolve = r }) }))
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { unmount } = render(<Page />)
  unmount()
  expect(signal?.aborted).toBe(true)
  resolve(new Response(JSON.stringify({ lines }), { status: 200 }))
  await Promise.resolve()
  expect(errorSpy).not.toHaveBeenCalled()
  errorSpy.mockRestore()
})
