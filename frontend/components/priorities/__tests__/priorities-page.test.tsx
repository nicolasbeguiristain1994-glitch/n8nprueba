import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
const state=vi.hoisted(()=>({user:{role:'admin',id:'owner'},permissions:{} as Record<string,string[]>}))
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>state}))
vi.mock('@/components/ui/dialog',async()=>{
  const {createElement:h}=await import('react')
  type P={open?:boolean;children?:React.ReactNode}
  return {Dialog:({open,children}:P)=>open?h('div',{role:'dialog'},children):null,
    DialogContent:({children}:P)=>h('div',null,children),DialogHeader:({children}:P)=>h('div',null,children),DialogTitle:({children}:P)=>h('h2',null,children)}
})
import Page from '@/app/(protected)/prioridades/page'
import { PriorityBroadcastComposer } from '../PriorityBroadcastComposer'
const contact={id:'00000000-0000-4000-8000-000000000001',firstName:'Ana',lastName:null,phoneNumber:'+5491100000001',platforms:[],priorityScore:90,valueTier:'vip',isBroadcasted:false}
const template={id:'00000000-0000-4000-8000-000000000002',name:'reactivar',status:'APROBADA',language:'es',waba_id:'waba',components:[{type:'BODY',text:'Hola {{1}}, tenemos novedades'}]}
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status})
let fetchMock:ReturnType<typeof vi.fn>
beforeEach(()=>{
  state.user.role='admin';state.permissions={}
  fetchMock=vi.fn(async(input:string)=>{
    if(input.startsWith('/api/contacts/prioritized?'))return response({data:[contact,{...contact,id:'busy',firstName:'Luz',broadcastBusy:true,broadcastState:'pending'}],total:2,totalPages:1,page:1,pageSize:50})
    if(input==='/api/contacts/prioritized/broadcasts')return response({broadcasts:[]})
    if(input.startsWith('/api/templates'))return response({templates:[template]})
    return response({started:true})
  });vi.stubGlobal('fetch',fetchMock)
})
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
describe('Priority broadcast interface',()=>{
  it('selects available contacts only and does not send until confirmation',async()=>{
    render(<Page/>);const ana=await screen.findByRole('checkbox',{name:'Seleccionar Ana'})
    expect(screen.getByRole('checkbox',{name:'Seleccionar Luz'})).toBeDisabled()
    fireEvent.click(ana);fireEvent.click(screen.getByRole('button',{name:'Difundir seleccionados (1)'}))
    await screen.findByRole('option',{name:'reactivar · es'})
    fireEvent.change(screen.getByLabelText('Plantilla aprobada'),{target:{value:template.id}})
    expect(screen.getByRole('button',{name:'Confirmar y enviar a 1'})).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'Usar nombre del contacto'}))
    expect(screen.getByText('Hola Pablo, tenemos novedades')).toBeInTheDocument()
    expect(fetchMock.mock.calls.every(([,init])=>!init || (init as RequestInit).method!=='POST')).toBe(true)
    fireEvent.click(screen.getByRole('button',{name:'Cancelar'}))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('clears selection when switching the platform and hides send actions for viewers',async()=>{
    const view=render(<Page/>);fireEvent.click(await screen.findByRole('checkbox',{name:'Seleccionar Ana'}))
    fireEvent.click(screen.getByRole('button',{name:'Zeus'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Difundir seleccionados'})).toBeDisabled())
    state.user.role='viewer';view.rerender(<Page/>)
    expect(screen.queryByRole('button',{name:/Difundir seleccionados/})).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox',{name:'Seleccionar Ana'})).not.toBeInTheDocument()
  })
  it('retries a lost creation response with the identical request ID and frozen selection',async()=>{
    const prepared=vi.fn();let attempts=0;const payloads:unknown[]=[]
    fetchMock.mockImplementation(async(input:string,init?:RequestInit)=>{
      if(input.startsWith('/api/templates'))return response({templates:[template]})
      payloads.push(JSON.parse(String(init?.body)));attempts++
      if(attempts===1)throw Error('Conexión interrumpida')
      return response({campaign_id:'batch'})
    })
    render(<PriorityBroadcastComposer contacts={[contact]} onClose={vi.fn()} onPrepared={prepared}/>)
    await screen.findByRole('option',{name:'reactivar · es'});fireEvent.change(screen.getByLabelText('Plantilla aprobada'),{target:{value:template.id}})
    fireEvent.click(screen.getByRole('button',{name:'Usar nombre del contacto'}))
    fireEvent.click(screen.getByRole('button',{name:'Confirmar y enviar a 1'}))
    await screen.findByText('Conexión interrumpida')
    expect(screen.getByLabelText('Plantilla aprobada')).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'Reintentar misma difusión'}))
    await waitFor(()=>expect(prepared).toHaveBeenCalledWith('batch'))
    expect(payloads[0]).toEqual(payloads[1])
  })
})
