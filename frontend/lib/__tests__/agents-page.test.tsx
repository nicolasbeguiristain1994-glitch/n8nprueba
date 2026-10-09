import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import AgentsPage from '@/app/(protected)/agentes/page'
const mocks=vi.hoisted(()=>({role:'admin'}))
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({user:{role:mocks.role},loading:false})}))
const agents=[{code:'royal',name:'Royal',lines:[{id:'line-8',agent_code:'royal',linea:8,variant:'a',label:'Royal 8A',phone:'+5491112345678',is_active:true,updated_at:'2026-10-09'}]}]
const fetcher=vi.fn()
beforeEach(()=>{
  mocks.role='admin';fetcher.mockReset().mockImplementation(async(_url:string,init?:RequestInit)=>
    new Response(JSON.stringify(init?.method?{ok:true}:{agents}),{status:200}))
  vi.stubGlobal('fetch',fetcher)
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('Agents management',()=>{
  it('shows existing lines and saves edits without changing their assignment',async()=>{
    render(<AgentsPage/>)
    fireEvent.click(await screen.findByRole('button',{name:'Editar Royal Línea 8A'}))
    const modal=screen.getByRole('dialog')
    expect(within(modal).getByLabelText('Número de línea')).toBeDisabled()
    expect(within(modal).getByLabelText('Variante')).toBeDisabled()
    fireEvent.change(within(modal).getByLabelText('Teléfono'),{target:{value:'+5491199999999'}})
    fireEvent.click(within(modal).getByLabelText('Línea activa'))
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/agents/royal/lines/line-8',expect.objectContaining({
      method:'PATCH',body:JSON.stringify({label:'Royal 8A',phone:'+5491199999999',is_active:false}),
    })))
    expect(await screen.findByText('Cambios guardados')).toBeInTheDocument()
  })
  it('creates an exact line and leaves duplicate errors in the dialog for correction',async()=>{
    render(<AgentsPage/>)
    fireEvent.click(await screen.findByRole('button',{name:'Agregar línea a Royal'}))
    const modal=screen.getByRole('dialog')
    fireEvent.change(within(modal).getByLabelText('Número de línea'),{target:{value:'8'}})
    fireEvent.change(within(modal).getByLabelText('Variante'),{target:{value:'a'}})
    fireEvent.change(within(modal).getByLabelText('Nombre de la línea'),{target:{value:'Nueva 8A'}})
    fireEvent.change(within(modal).getByLabelText('Teléfono'),{target:{value:'+5491112345678'}})
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:'Ya existe esa línea'}),{status:409}))
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe esa línea')
    expect(fetcher).toHaveBeenCalledWith('/api/agents/royal/lines',expect.objectContaining({method:'POST',
      body:JSON.stringify({label:'Nueva 8A',phone:'+5491112345678',is_active:true,linea:8,variant:'a'})}))
    expect(screen.getByRole('dialog')).toBeVisible()
  })
  it('lets the admin add an agent using its Contacts identifier',async()=>{
    render(<AgentsPage/>)
    await screen.findByText('+5491112345678')
    fireEvent.click(screen.getByRole('button',{name:'Nuevo agente'}))
    const modal=screen.getByRole('dialog')
    fireEvent.change(within(modal).getByLabelText('Nombre del agente'),{target:{value:'Mi agente'}})
    fireEvent.change(within(modal).getByLabelText('Identificador en Contactos'),{target:{value:'mi-agente'}})
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/agents',expect.objectContaining({method:'POST',body:JSON.stringify({name:'Mi agente',code:'mi-agente'})})))
  })
  it('does not fetch the directory or offer changes to operators',()=>{
    mocks.role='operator';render(<AgentsPage/>)
    expect(screen.getByRole('alert')).toHaveTextContent('Solo los administradores')
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByRole('button',{name:'Nuevo agente'})).not.toBeInTheDocument()
  })
})
