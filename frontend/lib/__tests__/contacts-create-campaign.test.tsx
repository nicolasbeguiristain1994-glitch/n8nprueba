import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), canCreate: true, total: 3 }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('@/lib/campaign-selection-draft', () => ({ saveCampaignSelection: mocks.save }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id:'owner',role:'operator' }, permissions: { contacts:['read'], campaigns:mocks.canCreate?['read','create']:['read'] } }) }))
import Contacts from '@/app/(protected)/contacts/page'
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333']
const contact = (id: string, n: number) => ({ id,first_name:`Fixture ${n}`,phone_number:`+549110000000${n}`,last_name:'',status:'active',opt_in:true,created_at:'2026-10-01',segment:'bajo',platforms:['otros'] })
beforeEach(() => {
  mocks.canCreate=true;mocks.total=3;mocks.save.mockReturnValue('draft-token')
  mocks.fetch.mockImplementation(async (url: string) => url.includes('select_all=true')
    ? {ids,phones:ids.map((_,i)=>`+549110000000${i}`)}
    : url.includes('/api/contacts/history') ? { history:[] }
    : { contacts:[contact(ids[0],1),contact(ids[1],2)],total:mocks.total,lists:[] })
})
afterEach(() => {cleanup();vi.restoreAllMocks();vi.clearAllMocks()})
it('requires a filter or selection and carries exactly the checked IDs', async () => {
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{})
  expect(screen.getByRole('button',{name:'Crear campaña'})).toBeDisabled()
  await userEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0])
  fireEvent.click(screen.getAllByRole('button',{name:'Crear campaña (1)'})[0])
  expect(mocks.save).toHaveBeenCalledWith('owner',[ids[0]])
  expect(navigate).toHaveBeenCalledWith('/campaigns?action=new&selection=draft-token')
})
it('carries the entire filtered selection, including contacts beyond the visible page', async () => {
  vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{})
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Seleccionar todos'}))})
  fireEvent.click(screen.getAllByRole('button',{name:'Crear campaña (3)'})[0])
  expect(mocks.save).toHaveBeenCalledWith('owner',ids)
})
it('hides campaign creation when permission is missing', async () => {
  mocks.canCreate=false;render(<Contacts/>);await act(async()=>{})
  expect(screen.queryByRole('button',{name:'Crear campaña'})).not.toBeInTheDocument()
})
it('keeps contacts selected if browser storage fails', async () => {
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  mocks.save.mockImplementationOnce(()=>{throw Error('quota')})
  render(<Contacts/>);await act(async()=>{})
  await userEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0])
  fireEvent.click(screen.getAllByRole('button',{name:'Crear campaña (1)'})[0])
  expect(navigate).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo preparar la selección')
  expect(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0]).toBeChecked()
})

const filterContacts = async () => {
  fireEvent.change(screen.getByPlaceholderText(/Buscar por nombre o teléfono/), {target:{value:'Fixture'}})
  await waitFor(() => expect(screen.getByRole('button',{name:`Crear campaña (${mocks.total.toLocaleString('es-AR')})`})).toBeEnabled())
}
const selectionRequests = () => mocks.fetch.mock.calls.filter(([url]) => url.includes('select_all=true'))

it('opens a campaign for all 91 filtered contacts without checking rows, including other pages', async () => {
  const allIds = Array.from({length:91},(_,i)=>`11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`)
  const base=mocks.fetch.getMockImplementation()!
  mocks.total=91
  mocks.fetch.mockImplementation((url, init) => url.includes('select_all=true') ? Promise.resolve({ids:allIds}) : base(url,init))
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{});await filterContacts()
  for (const checkbox of screen.getAllByRole('checkbox',{name:'Seleccionar fila'})) expect(checkbox).not.toBeChecked()
  expect(screen.getByText(/91 contactos que coinciden con los filtros, de todas las páginas/)).toBeVisible()
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Crear campaña (91)'}))})
  const params=new URL(selectionRequests()[0][0],'https://example.test').searchParams
  expect(params.get('q')).toBe('Fixture')
  expect(params.has('page')).toBe(false)
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith('owner',allIds)
  expect(navigate).toHaveBeenCalledWith('/campaigns?action=new&selection=draft-token')
})

it('uses the explicit subset instead of all filtered contacts', async () => {
  vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{});await filterContacts()
  await userEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[1])
  await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:'Crear campaña (1)'})[0])})
  expect(mocks.save).toHaveBeenCalledWith('owner',[ids[1]])
  expect(selectionRequests()).toHaveLength(0)
})

it.each(['filter','selection','unmount'])('discards a pending audience after a %s change', async change => {
  let resolve!: (data: {ids:string[]}) => void
  const pending=new Promise<{ids:string[]}>(done=>{resolve=done})
  const base=mocks.fetch.getMockImplementation()!
  mocks.fetch.mockImplementation((url,init)=>url.includes('select_all=true')?pending:base(url,init))
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  const view=render(<Contacts/>);await act(async()=>{});await filterContacts()
  fireEvent.click(screen.getByRole('button',{name:'Crear campaña (3)'}))
  expect(screen.getByRole('button',{name:'Preparando campaña…'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'Seleccionar todos'})).toBeDisabled()
  if(change==='filter') fireEvent.change(screen.getByPlaceholderText(/Buscar por nombre o teléfono/),{target:{value:'Otra'}})
  else if(change==='selection') await userEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0])
  else view.unmount()
  expect(selectionRequests()[0][1].signal.aborted).toBe(true)
  await act(async()=>{resolve({ids})})
  expect(mocks.save).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
})

it('keeps the audience available to retry when resolving the filter fails', async () => {
  const base=mocks.fetch.getMockImplementation()!
  let failed=true
  mocks.fetch.mockImplementation((url,init)=>url.includes('select_all=true')&&failed?Promise.reject(new Error('HTTP 503')):base(url,init))
  vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{});await filterContacts()
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Crear campaña (3)'}))})
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudieron recuperar los contactos del filtro')
  expect(mocks.save).not.toHaveBeenCalled()
  failed=false
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Crear campaña (3)'}))})
  expect(mocks.save).toHaveBeenCalledWith('owner',ids)
})

it('does not open an empty or oversized filtered audience', async () => {
  const base=mocks.fetch.getMockImplementation()!
  mocks.fetch.mockImplementation((url,init)=>url.includes('select_all=true')?Promise.resolve({ids:[]}):base(url,init))
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{});await filterContacts()
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Crear campaña (3)'}))})
  expect(screen.getByRole('alert')).toHaveTextContent('Ya no hay contactos')
  mocks.total=100001
  fireEvent.change(screen.getByPlaceholderText(/Buscar por nombre o teléfono/),{target:{value:'Otra'}})
  await waitFor(()=>expect(screen.getByRole('button',{name:'Crear campaña (100.001)'})).toBeEnabled())
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Crear campaña (100.001)'}))})
  expect(screen.getByRole('alert')).toHaveTextContent('La selección supera 100.000 contactos')
  expect(selectionRequests()).toHaveLength(1)
  expect(mocks.save).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
})

it('disables creation when the filter has no matches', async () => {
  mocks.total=0
  render(<Contacts/>);await act(async()=>{})
  fireEvent.change(screen.getByPlaceholderText(/Buscar por nombre o teléfono/),{target:{value:'Inexistente'}})
  await waitFor(()=>expect(screen.getByText('No hay contactos que coincidan con los filtros.')).toBeVisible())
  expect(screen.getByRole('button',{name:'Crear campaña'})).toBeDisabled()
})
