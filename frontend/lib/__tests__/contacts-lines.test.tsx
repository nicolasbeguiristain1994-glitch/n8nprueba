import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn() }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id: 'one', role: 'admin', can_download_contacts: true }, permissions: { contacts: ['read', 'create', 'delete'] } }) }))
vi.mock('@/lib/vcf-export', () => ({ downloadSingleVcf: vi.fn(), downloadZippedVcf: vi.fn() }))
import { fetchJson } from '@/lib/fetchJson'
import { downloadSingleVcf } from '@/lib/vcf-export'
import { DEFAULT_CONTACT_VIEW } from '@/components/contacts/SavedContactViews'
import Contacts from '@/app/(protected)/contacts/page'

const contact = { id: '00000000-0000-4000-8000-000000000001', first_name: 'Fixture', last_name: '', phone_number: '+5491100000001', status: 'active', opt_in: true, created_at: '2026-10-01', segment: 'bajo', linea: 2, platforms: ['otros'] }
const fetchMock = vi.fn()
const contactsCalls = () => vi.mocked(fetchJson).mock.calls.filter(([url]) => String(url).startsWith('/api/contacts?'))
const lastParams = () => new URL(String(contactsCalls().at(-1)?.[0]), 'http://localhost').searchParams
const legacy = { ...DEFAULT_CONTACT_VIEW, linea: '2', lineaSub: 'b', panel: 'royal' }
beforeEach(() => {
  localStorage.clear()
  vi.mocked(fetchJson).mockImplementation(async url => {
    const q = new URL(String(url), 'http://localhost').searchParams
    if (q.get('select_all') === 'true') return { ids: [contact.id], phones: [contact.phone_number] } as never
    return { contacts: [contact], total: 120, lists: [] } as never
  })
  fetchMock.mockImplementation(async (url: string) => String(url).startsWith('/api/contacts?')
    ? Response.json({ contacts: [contact], total: 1 }) : Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })
async function mountLegacy() {
  localStorage.setItem('crm:contact-views:one', JSON.stringify([{ id: 'old', name: 'Línea anterior', state: legacy }]))
  render(<Contacts />)
  await waitFor(() => expect(contactsCalls()).toHaveLength(1))
  fireEvent.change(screen.getByLabelText('Vista de contactos'), { target: { value: 'old' } })
  await waitFor(() => expect(lastParams().get('linea')).toBe('2'))
  fireEvent.click(screen.getByRole('button', { name: /^Filtros/ }))
}
async function addLine7() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Filtrar por líneas: Línea 2' }))
  expect(await screen.findByRole('checkbox', { name: 'Línea 2' })).toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: 'Línea 7' }))
  await user.click(screen.getByRole('button', { name: 'Listo' }))
  await waitFor(() => expect(lastParams().get('linea')).toBe('2,7'))
  return user
}
it('applies legacy views, combines lines with other filters, resets page/selection and clears the last line', async () => {
  await mountLegacy()
  const user = await addLine7()
  expect(lastParams().get('panel')).toBe('royal')
  expect(lastParams().get('linea_sub')).toBe('b')
  expect(screen.getByLabelText('Filtros activos')).toHaveTextContent('Líneas: 2, 7')
  await user.click(screen.getByRole('button', { name: 'Página siguiente' }))
  await waitFor(() => expect(lastParams().get('page')).toBe('2'))
  await user.click(screen.getByRole('button', { name: 'Seleccionar todos' }))
  await screen.findByRole('toolbar', { name: 'Acciones para 1 elementos seleccionados' })
  await user.click(screen.getByRole('button', { name: 'Filtrar por líneas: 2 líneas' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Línea 2' }))
  await user.click(screen.getByRole('button', { name: 'Listo' }))
  await waitFor(() => {
    expect(lastParams().get('linea')).toBe('7')
    expect(lastParams().get('page')).toBe('1')
  })
  expect(screen.queryByRole('toolbar', { name: /elementos seleccionados/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Filtrar por líneas: Línea 7' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Línea 7' }))
  await user.click(screen.getByRole('button', { name: 'Listo' }))
  await waitFor(() => expect(lastParams().get('linea')).toBe(''))
  expect(screen.getByLabelText('Filtros activos')).not.toHaveTextContent('Línea:')
  await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }))
  await waitFor(() => {
    expect(lastParams().get('panel')).toBe('')
    expect(lastParams().get('linea_sub')).toBe('')
  })
  expect(screen.queryByRole('button', { name: 'Limpiar filtros' })).not.toBeInTheDocument()
})
it('uses the same multiple-line audience for select-all, export, dynamic lists and fixed lists', async () => {
  await mountLegacy()
  const user = await addLine7()
  await user.click(screen.getByRole('button', { name: 'Seleccionar todos' }))
  await waitFor(() => expect(lastParams().get('select_all')).toBe('true'))
  expect(lastParams().get('linea')).toBe('2,7')

  await user.click(screen.getByRole('button', { name: 'Descargar' }))
  const downloadDialog = await screen.findByRole('dialog', { name: 'Descargar contactos' })
  await user.click(within(downloadDialog).getByRole('button', { name: 'Descargar' }))
  await waitFor(() => expect(downloadSingleVcf).toHaveBeenCalledOnce())
  const exportUrl = fetchMock.mock.calls.find(([url]) => String(url).includes('download=true'))![0]
  expect(new URL(exportUrl, 'http://localhost').searchParams.get('linea')).toBe('2,7')

  for (const dynamic of [true, false]) {
    await user.click(screen.getByRole('button', { name: 'Crear lista (120)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Crear lista de distribución' })
    if (!dynamic) await user.click(within(dialog).getByRole('checkbox', { name: /Actualizar automáticamente/ }))
    fireEvent.change(within(dialog).getByPlaceholderText('Nombre de la lista (ej: Betcoin Slots VIP)'), { target: { value: dynamic ? 'Dinámica 2 y 7' : 'Fija 2 y 7' } })
    await user.click(within(dialog).getByRole('button', { name: 'Crear lista' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Crear lista de distribución' })).not.toBeInTheDocument())
    const body = JSON.parse(fetchMock.mock.calls.filter(([url]) => url === '/api/lists').at(-1)![1].body)
    if (dynamic) expect(body).toMatchObject({ is_dynamic: true, filters: { linea: '2,7', panel: 'royal', linea_sub: 'b' } })
    else {
      expect(body).toMatchObject({ contact_ids: [contact.id] })
      expect(lastParams().get('select_all')).toBe('true')
      expect(lastParams().get('linea')).toBe('2,7')
    }
  }
})
