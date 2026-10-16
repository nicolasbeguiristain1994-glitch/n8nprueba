import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), canCreate: true }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('@/lib/campaign-selection-draft', () => ({ saveCampaignSelection: mocks.save }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id:'owner',role:'operator' }, permissions: { contacts:['read'], campaigns:mocks.canCreate?['read','create']:['read'] } }) }))
import Contacts from '@/app/(protected)/contacts/page'
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333']
const contact = (id: string, n: number) => ({ id,first_name:`Fixture ${n}`,phone_number:`+549110000000${n}`,last_name:'',status:'active',opt_in:true,created_at:'2026-10-01',segment:'bajo',platforms:['otros'] })
beforeEach(() => {
  mocks.canCreate=true;mocks.save.mockReturnValue('draft-token')
  mocks.fetch.mockImplementation(async (url: string) => url.includes('select_all=true')
    ? {ids,phones:ids.map((_,i)=>`+549110000000${i}`)}
    : { contacts:[contact(ids[0],1),contact(ids[1],2)],total:3,lists:[] })
})
afterEach(() => {cleanup();vi.restoreAllMocks();vi.clearAllMocks()})
it('enables the action only after selection and carries exactly those IDs', async () => {
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  render(<Contacts/>);await act(async()=>{})
  expect(screen.getByRole('button',{name:'Crear campaña'})).toBeDisabled()
  await userEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0])
  fireEvent.click(screen.getAllByRole('button',{name:'Crear campaña (1)'})[0])
  expect(mocks.save).toHaveBeenCalledWith('owner',[ids[0]])
  expect(navigate).toHaveBeenCalledWith('/campaigns?action=new&selection=draft-token')
})
it('selects all 91 filtered contacts across both pages and carries them into campaign creation', async () => {
  const navigate=vi.spyOn(window.location,'assign').mockImplementation(()=>{})
  const allIds=Array.from({length:91},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)
  mocks.fetch.mockImplementation(async (input: string) => {
    const url=new URL(input,'http://localhost'),q=url.searchParams
    if(q.get('select_all')==='true') return {ids:allIds,phones:allIds.map((_,i)=>`+549110000${i}`)}
    if(url.pathname==='/api/contacts') return {contacts:allIds.slice(q.get('page')==='2'?50:0,q.get('page')==='2'?91:50).map(contact),total:91}
    return {lists:[],history:[]}
  })
  render(<Contacts/>);await act(async()=>{})
  fireEvent.change(screen.getByRole('textbox',{name:'Buscar contactos'}),{target:{value:'Fixture'}})
  const selection=within(screen.getByRole('region',{name:'Selección de contactos'}))
  const rows=()=>within(screen.getByRole('grid')).getAllByRole('checkbox',{name:'Seleccionar fila'})
  await waitFor(()=>expect(selection.getByRole('button',{name:'Seleccionar los 91 filtrados'})).toBeEnabled())
  expect(rows()).toHaveLength(50)
  await act(async()=>{fireEvent.click(selection.getByRole('button',{name:'Seleccionar los 91 filtrados'}))})
  const selectionRequest=new URL(mocks.fetch.mock.calls.find(([url])=>url.includes('select_all=true'))![0],'http://localhost')
  expect(selectionRequest.searchParams.get('q')).toBe('Fixture')
  expect(selectionRequest.searchParams.has('page')).toBe(false)
  expect(selection.getByRole('status')).toHaveTextContent('91 de 91 contactos seleccionados')
  rows().forEach(row=>expect(row).toBeChecked())
  fireEvent.click(screen.getByRole('button',{name:'Página siguiente'}))
  await waitFor(()=>expect(rows()).toHaveLength(41))
  expect(selection.getByRole('status')).toHaveTextContent('91 de 91 contactos seleccionados')
  rows().forEach(row=>expect(row).toBeChecked())
  fireEvent.click(selection.getByRole('button',{name:'Crear campaña (91)'}))
  expect(mocks.save).toHaveBeenCalledWith('owner',allIds)
  expect(navigate).toHaveBeenCalledWith('/campaigns?action=new&selection=draft-token')
},15000)

it('disables campaign creation during select-all and discards selection when filters change', async () => {
  let finish!: (value: unknown)=>void
  const initial=mocks.fetch.getMockImplementation()!
  mocks.fetch.mockImplementation((url: string,...args: unknown[])=>url.includes('select_all=true')?new Promise(resolve=>{finish=resolve}):initial(url,...args))
  render(<Contacts/>);await act(async()=>{})
  fireEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0])
  fireEvent.click(screen.getByRole('button',{name:'Seleccionar los 3 contactos'}))
  expect(screen.getByRole('button',{name:'Seleccionando…'})).toBeDisabled()
  expect(screen.getAllByRole('button',{name:'Crear campaña (1)'}).every(button=>(button as HTMLButtonElement).disabled)).toBe(true)
  fireEvent.change(screen.getByRole('textbox',{name:'Buscar contactos'}),{target:{value:'Nueva búsqueda'}})
  const request=mocks.fetch.mock.calls.find(([url])=>url.includes('select_all=true'))!
  expect(request[1].signal.aborted).toBe(true)
  await act(async()=>{finish({ids,phones:ids.map(()=>'+5491100000000')})})
  await waitFor(()=>expect(screen.getByRole('button',{name:'Seleccionar los 3 filtrados'})).toBeEnabled())
  expect(screen.getByRole('button',{name:'Crear campaña'})).toBeDisabled()
  expect(screen.queryByRole('toolbar',{name:/elementos seleccionados/})).not.toBeInTheDocument()
})

it('shows select-all errors beside the action and allows retrying without losing selected contacts', async () => {
  const initial=mocks.fetch.getMockImplementation()!
  mocks.fetch.mockImplementation((url: string,...args: unknown[])=>url.includes('select_all=true')?Promise.reject(Error('No se pudo seleccionar la audiencia')):initial(url,...args))
  render(<Contacts/>);await act(async()=>{})
  fireEvent.click(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0])
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Seleccionar los 3 contactos'}))})
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo seleccionar la audiencia')
  expect(screen.getByRole('button',{name:'Seleccionar los 3 contactos'})).toBeEnabled()
  expect(screen.getAllByRole('checkbox',{name:'Seleccionar fila'})[0]).toBeChecked()
  expect(mocks.save).not.toHaveBeenCalled()
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
