import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({fetch:vi.fn(),fail:false,total:1}))
vi.mock('@/lib/fetchJson',()=>({fetchJson:mocks.fetch}))
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({user:{id:'owner',role:'admin'},permissions:{contacts:['read'],campaigns:['read','create']}})}))
import Contacts from '@/app/(protected)/contacts/page'
const contact={id:'11111111-1111-4111-8111-111111111111',first_name:'Fixture',last_name:'',phone_number:'+5491100000001',status:'active',opt_in:true,created_at:'2026-10-01',segment:'bajo',platforms:['otros']}
beforeEach(()=>{
 mocks.fail=false;mocks.total=1
 mocks.fetch.mockImplementation(async(url:string)=>{
  if(url.startsWith('/api/contacts?')){
   if(mocks.fail)throw Error('HTTP 503: {"error":"La base de datos demoró en responder. Volvé a intentar en unos segundos."}')
   return {contacts:mocks.total?[contact]:[],total:mocks.total}
  }
  if(url.startsWith('/api/contacts/history'))return {history:[]}
  return {lists:[]}
 })
})
afterEach(()=>{cleanup();vi.clearAllMocks()})
it('distinguishes a failed filtered load from zero contacts and retries the same audience',async()=>{
 render(<Contacts/>);await act(async()=>{})
 mocks.fail=true
 fireEvent.change(screen.getByRole('textbox',{name:'Buscar contactos'}),{target:{value:'Fixture'}})
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('La base de datos demoró en responder.'))
 expect(screen.getByRole('alert')).not.toHaveTextContent('HTTP 503')
 expect(screen.getByRole('heading',{name:'Contactos',exact:true}).parentElement).toHaveTextContent(/^Contactos$/)
 expect(screen.queryByText('No hay contactos que coincidan con los filtros.')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'Crear campaña',exact:true})).toBeDisabled()
 expect(screen.getByRole('button',{name:'Seleccionar todos'})).toBeDisabled()
 expect(screen.queryByRole('button',{name:'Eliminar (0)'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Crear lista (0)'})).not.toBeInTheDocument()
 mocks.fail=false
 fireEvent.click(screen.getByRole('button',{name:'Reintentar'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Crear campaña (1)'})).toBeEnabled())
 expect(screen.queryByRole('alert')).not.toBeInTheDocument()
 expect(screen.getByRole('textbox',{name:'Buscar contactos'})).toHaveValue('Fixture')
 expect(mocks.fetch.mock.calls.filter(([url])=>url.startsWith('/api/contacts?')).at(-1)?.[0]).toContain('q=Fixture')
})
it('still reports a genuine zero-result filter after a successful response',async()=>{
 mocks.total=0
 render(<Contacts/>);await act(async()=>{})
 fireEvent.change(screen.getByRole('textbox',{name:'Buscar contactos'}),{target:{value:'Inexistente'}})
 await waitFor(()=>expect(screen.getByText('No hay contactos que coincidan con los filtros.')).toBeVisible())
 expect(screen.getByRole('heading',{name:'Contactos',exact:true}).parentElement).toHaveTextContent(/^Contactos0$/)
 expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
