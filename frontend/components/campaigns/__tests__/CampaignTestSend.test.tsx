import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CampaignTestSend } from '../CampaignTestSend'

const recipient = { id: 'recipient', first_name: 'Pablo', phone_number: '+5491112345678' }
const line = { id: 'line', display_name: 'Solbatt', phone_number_id: '12345' }
const snapshot = { recipients: [recipient], lines: [line], attempts: [] }
const attempt = { ...recipient, id: 'attempt', line_name: 'Solbatt', status: 'sent', error: null }
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
    expect(screen.getByRole('status')).toHaveTextContent('La entrega se confirma en el WhatsApp destinatario')
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
