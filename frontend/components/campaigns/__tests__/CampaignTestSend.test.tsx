import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CampaignTestSend } from '../CampaignTestSend'

const recipient = { id: 'recipient', first_name: 'Pablo', phone_number: '+5491112345678' }
const line = { id: 'line', display_name: 'Solbatt', phone_number_id: '12345' }
const snapshot = { recipients: [recipient], lines: [line], attempts: [] }
const attempt = { ...recipient, id: 'attempt', line_name: 'Solbatt', status: 'sent', error: null, created_at: '2026-10-08T22:07:04.000Z' }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const fetchMock = vi.fn()
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function open() {
  render(<CampaignTestSend campaignId="campaign" />)
  expect(fetchMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prueba' }))
  await screen.findByLabelText('Número de prueba')
}
describe('test send panel', () => {
  it('shows a newly available line after refreshing an empty snapshot without sending', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...snapshot, lines: [] }))
      .mockResolvedValueOnce(response(snapshot))
    await open()
    expect(screen.getByText(/No hay líneas disponibles para esta plantilla/)).toHaveTextContent('misma cuenta de WhatsApp de la plantilla, estar habilitada y tener cupo disponible')
    expect(screen.getByLabelText('Línea de envío')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Enviar prueba a este número' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar pruebas' }))
    await waitFor(() => expect(screen.getByLabelText('Línea de envío')).toHaveValue('line'))
    expect(screen.getByRole('option', { name: 'Solbatt' })).toBeInTheDocument()
    expect(screen.queryByText(/No hay líneas disponibles para esta plantilla/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar prueba a este número' })).toBeEnabled()
    expect(fetchMock.mock.calls).toEqual([
      ['/api/campaigns/campaign/test-send'],
      ['/api/campaigns/campaign/test-send'],
    ])
  })
  it('sends once on a double click and displays acceptance separately from delivery', async () => {
    let resolveSend!: (r: Response) => void
    fetchMock.mockImplementation((_url, init) => init?.method === 'POST'
      ? new Promise<Response>(resolve => { resolveSend = resolve }) : Promise.resolve(response(snapshot)))
    await open()
    const button = screen.getByRole('button', { name: 'Enviar prueba a este número' })
    fireEvent.click(button); fireEvent.click(button)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    const payload = JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')![1].body)
    expect(payload).toMatchObject({ recipient_id: 'recipient', line_id: 'line' })
    expect(payload).not.toHaveProperty('phone_number')
    await act(async () => resolveSend(response({ attempt })))
    expect(screen.getByRole('status')).toHaveTextContent('Aceptado por Meta')
    expect(screen.getByRole('status')).toHaveTextContent('Todavía no hay confirmación de entrega')
    expect(screen.getByRole('status')).not.toHaveClass('text-success')
  })
  it.each([
    { status: 'failed', label: 'Falló', color: 'text-destructive', error: '[meta:141006] Payment method required.' },
    { status: 'delivered', label: 'Entregado', color: 'text-success', error: null },
    { status: 'read', label: 'Leído', color: 'text-success', error: null },
  ])('updates the highlighted result and history to $status when refreshed', async ({ status, label, color, error }) => {
    let sent = false
    let currentAttempt = { ...attempt, error: null as string | null }
    fetchMock.mockImplementation((_url, init) => {
      if (init?.method === 'POST') { sent = true; return Promise.resolve(response({ attempt })) }
      return Promise.resolve(response({ ...snapshot, attempts: sent
        ? [{ ...attempt, id: 'other-attempt', first_name: 'Ana', status: 'uncertain' }, currentAttempt] : [] }))
    })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar prueba a este número' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Aceptado por Meta')
      expect(screen.getByRole('button', { name: 'Actualizar pruebas' })).toBeEnabled()
    })

    currentAttempt = { ...attempt, status, error }
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar pruebas' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(label))
    expect(screen.getByRole('status')).toHaveClass(color)
    expect(screen.getByText(`Pablo · +5491112345678 · Solbatt · ${label}`)).toHaveClass(color)
    expect(screen.queryByText(/Aceptado por Meta/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Todavía no hay confirmación de entrega/)).not.toBeInTheDocument()
    if (error) {
      expect(screen.getByRole('status')).toHaveTextContent(error)
      expect(screen.getByText(error)).toBeInTheDocument()
    }
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('shows history timestamps in Argentina time using 24 hours', async () => {
    fetchMock.mockResolvedValue(response({ ...snapshot, attempts: [attempt] }))
    await open()
    expect(screen.getByText('8/10/2026, 19:07:04')).toBeInTheDocument()
  })
  it('reuses the same request after a lost response and locks destination changes', async () => {
    let posts = 0
    fetchMock.mockImplementation((_url, init) => init?.method === 'POST'
      ? ++posts === 1 ? Promise.reject(new TypeError('Error de red')) : Promise.resolve(response({ attempt }))
      : Promise.resolve(response(snapshot)))
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar prueba a este número' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('Número de prueba')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar prueba pendiente' }))
    await screen.findByRole('status')
    const calls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(calls).toHaveLength(2)
    expect(calls[0][1].body).toBe(calls[1][1].body)
  })
  it('registers a number without sending and requires a selected eligible line', async () => {
    let registered = false
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === 'POST') { registered = true; return Promise.resolve(response({ recipient }, 201)) }
      return Promise.resolve(response({ recipients: registered ? [recipient] : [], lines: [], attempts: [] }))
    })
    await open()
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Pablo' } })
    fireEvent.change(screen.getByLabelText('Teléfono con código de país'), { target: { value: '+5491112345678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar número' }))
    await waitFor(() => expect(screen.getByLabelText('Número de prueba')).toHaveValue('recipient'))
    expect(screen.getByRole('button', { name: 'Enviar prueba a este número' })).toBeDisabled()
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/test-send') && init?.method === 'POST')).toHaveLength(0)
  })
})
