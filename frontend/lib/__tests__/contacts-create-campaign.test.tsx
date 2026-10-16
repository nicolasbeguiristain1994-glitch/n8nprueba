import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
