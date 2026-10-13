import {afterEach,it,expect,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import Page from '@/app/(protected)/blacklist/page'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('requires a checked consent and its evidence before an administrator can reactivate a number',async()=>{
  const entry={id:'entry-1',phone_number_raw:'+5491100000001',phone_number_normalized:'5491100000001',
    reason:'Baja solicitada por el contacto',source:'automatic',added_at:'2026-10-13T10:00:00Z',removed_at:null,
    origin_line:'Nexus 4',input_type:'button',campaign_name:'Campaña de prueba'}
  const api=vi.fn(async(_url:string,init?:RequestInit)=>new Response(JSON.stringify(
    init?.method==='DELETE'?{ok:true}:{items:[entry],total:1}),{status:200}))
  vi.stubGlobal('fetch',api)
  render(<Page/>)
  expect(await screen.findByText('Baja solicitada por el contacto')).toBeInTheDocument()
  expect(screen.getByText('Línea: Nexus 4')).toBeInTheDocument()
  fireEvent.click(screen.getByTitle('Quitar de blacklist'))
  const confirm=await screen.findByRole('button',{name:'Sí, quitar de blacklist'})
  expect(confirm).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox',{name:'El contacto volvió a aceptar recibir mensajes.'}))
  expect(confirm).toBeDisabled()
  fireEvent.change(screen.getByPlaceholderText('Cuándo y por qué medio lo confirmó'),{target:{value:'Aceptó por WhatsApp hoy'}})
  expect(confirm).toBeEnabled();fireEvent.click(confirm)
  await waitFor(()=>expect(api.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(true))
  const call=api.mock.calls.find(([,init])=>init?.method==='DELETE')!
  expect(JSON.parse(String(call[1]?.body))).toEqual({consent_confirmed:true,consent_note:'Aceptó por WhatsApp hoy'})
})
