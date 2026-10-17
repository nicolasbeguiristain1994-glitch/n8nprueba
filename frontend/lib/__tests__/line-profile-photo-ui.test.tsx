import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LineProfilePhoto } from '@/components/lines/LineProfilePhoto'
const fetchMock = vi.fn()
const renderPhoto = () => render(<LineProfilePhoto lineId="line-one" name="Lexora" phone="+5491100000000" />)
const response = (data: unknown, status = 200) => ({ ok: status === 200, json: async () => data })
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
  fetchMock.mockImplementation(async (_url, options) => response(options?.method === 'POST'
    ? { success: true, pictureUrl: 'https://pps.whatsapp.net/new.jpg', refreshPending: false }
    : { pictureUrl: 'https://pps.whatsapp.net/current.jpg', canEdit: true }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('previews the selected image and saves only after the explicit button', async () => {
  renderPhoto(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Foto de WhatsApp de Lexora' }))
  expect(screen.getByRole('img', { name: 'Foto actual de Lexora' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeDisabled()
  const file = new File(['fixture'], 'photo.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('Elegir nueva foto'), { target: { files: [file] } })
  await waitFor(() => expect(screen.getByRole('img', { name: 'Vista previa de la nueva foto' })).toBeVisible())
  expect(fetchMock.mock.calls.filter(([,opts]) => opts?.method === 'POST')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Foto guardada'))
  expect(fetchMock.mock.calls.filter(([,opts]) => opts?.method === 'POST')).toHaveLength(1)
  expect(screen.getByRole('img', { name: 'Foto actual de Lexora' })).toHaveAttribute('src', 'https://pps.whatsapp.net/new.jpg')
})
it('cancels a preview without sending the image', async () => {
  renderPhoto(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Foto de WhatsApp de Lexora' }))
  fireEvent.change(screen.getByLabelText('Elegir nueva foto'), { target: { files: [new File(['x'], 'photo.png', { type: 'image/png' })] } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(fetchMock.mock.calls.filter(([,opts]) => opts?.method === 'POST')).toHaveLength(0)
})
it('displays a read error and can recover by updating the photo', async () => {
  fetchMock.mockResolvedValueOnce(response({ error: 'Meta no responde.' }, 502))
  renderPhoto(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Foto de WhatsApp de Lexora' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Meta no responde')
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar foto' }))
  await waitFor(() => expect(screen.getByLabelText('Elegir nueva foto')).toBeVisible())
})
it('shows the current photo without edit controls to a read-only user', async () => {
  fetchMock.mockResolvedValue(response({ pictureUrl: null, canEdit: false }))
  renderPhoto(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Foto de WhatsApp de Lexora' }))
  expect(screen.getByText('Sin foto de perfil')).toBeVisible()
  expect(screen.queryByLabelText('Elegir nueva foto')).not.toBeInTheDocument()
})
it('rejects unsupported files without enabling save', async () => {
  renderPhoto(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Foto de WhatsApp de Lexora' }))
  fireEvent.change(screen.getByLabelText('Elegir nueva foto'), { target: { files: [new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' })] } })
  expect(screen.getByRole('alert')).toHaveTextContent('JPG o PNG')
  expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeDisabled()
})
