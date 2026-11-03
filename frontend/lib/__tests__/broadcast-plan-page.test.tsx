import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react'
import { afterEach,beforeEach,it,expect,vi } from 'vitest'
vi.mock('@/components/priorities/PriorityBroadcastProgress',()=>({PriorityBroadcastProgress:()=>null}))
vi.mock('@/lib/fetchJson',()=>({fetchJson:vi.fn()}))
const state=vi.hoisted(()=>({role:'admin',permissions:{} as Record<string,string[]>}))
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({user:{role:state.role},permissions:state.permissions})}))
import { fetchJson } from '@/lib/fetchJson'
import Page from '@/app/(protected)/prioridades/page'
import { DailyBroadcastPlanner } from '@/components/campaigns/DailyBroadcastPlanner'
import type { BroadcastPlan } from '@/lib/broadcast-planner'

const catalogue={lines:[{id:'a',name:'Difusión A',type:'evolution'}],templates:[]}
const plan:BroadcastPlan={generatedAt:'2026-11-03T12:00:00Z',computedAt:'2026-11-03T10:00:00Z',endsAt:'2026-11-03T23:00:00Z',total:2,selected:1,pending:1,
  lines:[{id:'a',name:'Difusión A',type:'evolution',dailyLimit:500,hourlyLimit:50,used:200,committed:50,reserve:50,capacity:200,selected:1,reason:null}],
  contacts:[{id:'1',name:'Ana',phone:'5491111111111',score:98,segment:'REACTIVACION_PRIORITARIA',tier:'vip',agent:'royal',lineId:'a',reason:null},
    {id:'2',name:'Juan',phone:'5491122222222',score:90,segment:'REACTIVACION_PRIORITARIA',tier:'vip',agent:'royal',lineId:null,reason:'assigned_line_unavailable'}],
  reasons:[{code:'assigned_line_unavailable',label:'Línea habitual no disponible o no seleccionada',count:1}],warnings:['Vista previa: no reserva cupos ni crea campañas.']}
afterEach(cleanup)
beforeEach(()=>{vi.resetAllMocks();state.role='admin';state.permissions={}})

it('opens from Priorities with active filters and plans all pages, then shows contacts and pending reasons',async()=>{
  vi.mocked(fetchJson).mockImplementation(async (url,init)=>{
    if(String(url)==='/api/contacts/prioritized/plan')return init?.method==='POST'?plan:catalogue
    return {data:[],total:130,page:1,pageSize:50,totalPages:3}
  })
  render(<Page/>);fireEvent.click(screen.getByRole('button',{name:'Zeus'}))
  fireEvent.click(screen.getByRole('button',{name:'Preparar difusión de hoy'}))
  const dialog=await screen.findByRole('dialog')
  expect(within(dialog).getByText(/Incluye todas las páginas/)).toHaveTextContent('zeus')
  fireEvent.click(await within(dialog).findByRole('button',{name:'Calcular plan'}))
  expect(await within(dialog).findByText('Ana')).toBeInTheDocument()
  const post=vi.mocked(fetchJson).mock.calls.find(([,init])=>init?.method==='POST')!
  expect(JSON.parse(post[1]!.body as string)).toMatchObject({platform:'zeus',lineIds:['a'],maxContacts:500})
  expect(JSON.parse(post[1]!.body as string)).not.toHaveProperty('page')
  fireEvent.click(within(dialog).getByRole('button',{name:'Ver pendientes (1)'}))
  expect(within(dialog).getByText('Juan')).toBeInTheDocument()
  expect(within(dialog).getAllByText(/Línea habitual no disponible/).length).toBeGreaterThan(0)
  expect(vi.mocked(fetchJson).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1)
})

it('invalidates an old plan when capacity settings change',async()=>{
  vi.mocked(fetchJson).mockResolvedValueOnce(catalogue).mockResolvedValue(plan)
  render(<DailyBroadcastPlanner filters={{agent:'royal'}} onClose={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Calcular plan'}))
  expect(await screen.findByText('Ana')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Reserva para atención'),{target:{value:'20'}})
  expect(screen.queryByLabelText('Resultado del plan')).not.toBeInTheDocument()
  expect(screen.getByRole('button',{name:'Calcular plan'})).toBeEnabled()
})

it('keeps errors visible and permits retry, without treating them as an empty audience',async()=>{
  vi.mocked(fetchJson).mockRejectedValueOnce(Error('Líneas no disponibles')).mockResolvedValueOnce(catalogue).mockRejectedValue(Error('No se pudo calcular'))
  render(<DailyBroadcastPlanner filters={{}} onClose={()=>{}}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('Líneas no disponibles')
  fireEvent.click(screen.getByRole('button',{name:'Reintentar'}))
  fireEvent.click(await screen.findByRole('button',{name:'Calcular plan'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo calcular')
  expect(screen.queryByText(/No hay contactos pendientes para estos filtros/)).not.toBeInTheDocument()
})

it('does not expose the button to users lacking campaign creation or line access',async()=>{
  state.role='viewer';vi.mocked(fetchJson).mockResolvedValue({data:[],total:0,page:1,pageSize:50,totalPages:0})
  render(<Page/>);await screen.findByText('No hay contactos a difundir')
  expect(screen.queryByRole('button',{name:'Preparar difusión de hoy'})).not.toBeInTheDocument()
})

it('ignores a late response after closing the dialog',async()=>{
  let finish:(data:unknown)=>void=()=>{}
  vi.mocked(fetchJson).mockResolvedValueOnce(catalogue).mockImplementationOnce(()=>new Promise(r=>{finish=r}))
  const {unmount}=render(<DailyBroadcastPlanner filters={{}} onClose={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Calcular plan'}))
  await waitFor(()=>expect(screen.getByRole('button',{name:'Calculando…'})).toBeDisabled())
  unmount();await act(async()=>finish(plan))
  expect(screen.queryByText('Ana')).not.toBeInTheDocument()
})
