import React from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import Page from '@/app/(protected)/lines/subscriptions/page'
import { SUBSCRIPTION_PRESETS,subscriptionLink } from '@/lib/line-subscription-message'
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({permissions:{lines:['read','update']}})}))
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002'
const lines=[{id:A,display_name:'Tienda',phone_number:'+5491100000001',line_type:'cloud',can_edit:true},
  {id:B,display_name:'Solar',phone_number:'+5491100000002',line_type:'evolution',can_edit:true}]
let settings:Record<string,{brand_name:string;message_text:string;enabled:boolean}>
let requests:{url:string;init?:RequestInit}[]
beforeEach(()=>{
  settings={};requests=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    requests.push({url,init})
    if(init?.method==='PUT'){
      const data=JSON.parse(String(init.body));settings[data.lineId]={brand_name:data.brandName,message_text:data.message,enabled:data.enabled}
      return Response.json({settings:settings[data.lineId],link:subscriptionLink(lines.find(l=>l.id===data.lineId)!.phone_number,data.message)})
    }
    const id=new URL(url,'http://localhost').searchParams.get('lineId')
    if(!id)return Response.json({lines})
    const line=lines.find(l=>l.id===id)!
    return Response.json({lines,line,settings:settings[id]??null,link:settings[id]?subscriptionLink(line.phone_number,settings[id].message_text):null,
      stats:{subscribed:0,unsubscribed:0,renewal_required:0},records:[],hasMore:false})
  }))
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('saves a per-line preset before exposing a copyable link and preserves it when switching lines',async()=>{
  render(<Page/>);await screen.findByLabelText('Marca o negocio')
  fireEvent.change(screen.getByLabelText('Línea de WhatsApp'),{target:{value:A}})
  expect(screen.getByLabelText('Marca o negocio')).toHaveValue('Tienda')
  fireEvent.change(screen.getByLabelText('Usar un ejemplo'),{target:{value:'clothing'}})
  const expected=SUBSCRIPTION_PRESETS.clothing.replace('{marca}','Tienda')
  expect(screen.getByLabelText('Mensaje que enviará el cliente')).toHaveValue(expected)
  expect(screen.getByRole('button',{name:'Copiar enlace'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'Guardar configuración'}))
  await waitFor(()=>expect(screen.getByRole('button',{name:'Copiar enlace'})).toBeEnabled())
  expect(screen.getByLabelText('Enlace generado')).toHaveValue(subscriptionLink(lines[0].phone_number,expected))
  fireEvent.change(screen.getByLabelText('Línea de WhatsApp'),{target:{value:B}})
  await waitFor(()=>expect(screen.getByLabelText('Marca o negocio')).toHaveValue('Solar'))
  expect(screen.getByLabelText('Mensaje que enviará el cliente')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('Usar un ejemplo'),{target:{value:'solar'}})
  expect(screen.getByLabelText('Mensaje que enviará el cliente')).toHaveValue(SUBSCRIPTION_PRESETS.solar.replace('{marca}','Solar'))
  fireEvent.change(screen.getByLabelText('Línea de WhatsApp'),{target:{value:A}})
  await waitFor(()=>expect(screen.getByLabelText('Mensaje que enviará el cliente')).toHaveValue(expected))
  expect(requests.filter(r=>r.init?.method==='PUT')).toHaveLength(1)
})
it('does not offer a stale saved link while editing and validates the consent wording',async()=>{
  settings[A]={brand_name:'Tienda',message_text:SUBSCRIPTION_PRESETS.clothing.replace('{marca}','Tienda'),enabled:true}
  render(<Page/>);await screen.findByLabelText('Mensaje que enviará el cliente')
  fireEvent.change(screen.getByLabelText('Mensaje que enviará el cliente'),{target:{value:'Hola'}})
  expect(screen.getByRole('button',{name:'Copiar enlace'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'Guardar configuración'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('entre 20 y 1000')
  expect(requests.filter(r=>r.init?.method==='PUT')).toHaveLength(0)
})

it.each(['custom','preset'])('saves and links a %s message without the internal business name',async mode=>{
  render(<Page/>);await screen.findByLabelText('Mensaje que enviará el cliente')
  const custom='Quiero recibir promociones de tu Negocio por Whatsapp. Puedo cancelar escribiendo BAJA.'
  if(mode==='custom') fireEvent.change(screen.getByLabelText('Mensaje que enviará el cliente'),{target:{value:custom}})
  else fireEvent.change(screen.getByLabelText('Usar un ejemplo'),{target:{value:'withoutBrand'}})
  const expected=mode==='custom'?custom:SUBSCRIPTION_PRESETS.withoutBrand
  fireEvent.click(screen.getByRole('button',{name:'Guardar configuración'}))
  await waitFor(()=>expect(screen.getByRole('button',{name:'Copiar enlace'})).toBeEnabled())
  expect(settings[A]).toMatchObject({brand_name:'Tienda',message_text:expected})
  expect(screen.getByLabelText('Enlace generado')).toHaveValue(subscriptionLink(lines[0].phone_number,expected))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
