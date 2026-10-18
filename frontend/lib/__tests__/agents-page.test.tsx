import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import AgentsPage from '@/app/(protected)/agentes/page'
const mocks=vi.hoisted(()=>({role:'admin'}))
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({user:{role:mocks.role},loading:false})}))
const agents=[{code:'royal',name:'Royal',lines:[{id:'line-8',agent_code:'royal',linea:8,label:'Royal 8',phone:'+5491112345678',is_active:true,updated_at:'2026-10-09'}]}]
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
    fireEvent.click(await screen.findByRole('button',{name:'Editar Royal Línea 8'}))
    const modal=screen.getByRole('dialog')
    expect(within(modal).getByLabelText('Número de línea')).toBeDisabled()
    expect(within(modal).queryByLabelText('Variante')).not.toBeInTheDocument()
    expect(within(modal).getByLabelText('Teléfono')).toHaveValue('549 | 1112 | 345678')
    fireEvent.change(within(modal).getByLabelText('Teléfono'),{target:{value:'+5491199999999'}})
    fireEvent.click(within(modal).getByLabelText('Línea activa'))
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/agents/royal/lines/line-8',expect.objectContaining({
      method:'PATCH',body:JSON.stringify({label:'Royal 8',phone:'+5491199999999',link_url:'',is_active:false}),
    })))
    expect(await screen.findByText('Cambios guardados')).toBeInTheDocument()
  })
  it('creates an exact line and leaves duplicate errors in the dialog for correction',async()=>{
    render(<AgentsPage/>)
    fireEvent.click(await screen.findByRole('button',{name:'Agregar línea a Royal'}))
    const modal=screen.getByRole('dialog')
    fireEvent.change(within(modal).getByLabelText('Número de línea'),{target:{value:'8'}})
    fireEvent.change(within(modal).getByLabelText('Nombre de la línea'),{target:{value:'Nueva 8'}})
    fireEvent.change(within(modal).getByLabelText('Teléfono'),{target:{value:'+5491112345678'}})
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:'Ya existe esa línea'}),{status:409}))
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe esa línea')
    expect(fetcher).toHaveBeenCalledWith('/api/agents/royal/lines',expect.objectContaining({method:'POST',
      body:JSON.stringify({label:'Nueva 8',phone:'+5491112345678',link_url:'',is_active:true,linea:8})}))
    expect(screen.getByRole('dialog')).toBeVisible()
  })
  it('lets the admin add an agent using its Contacts identifier',async()=>{
    render(<AgentsPage/>)
    await screen.findByText('549 | 1112 | 345678')
    fireEvent.click(screen.getByRole('button',{name:'Nuevo agente'}))
    const modal=screen.getByRole('dialog')
    fireEvent.change(within(modal).getByLabelText('Nombre del agente'),{target:{value:'Mi agente'}})
    fireEvent.change(within(modal).getByLabelText('Identificador en Contactos'),{target:{value:'mi-agente'}})
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/agents',expect.objectContaining({method:'POST',body:JSON.stringify({name:'Mi agente',code:'mi-agente'})})))
  })
  it('saves a link and changes only the selected agent delivery mode',async()=>{
    render(<AgentsPage/>)
    const mode=await screen.findByRole('group',{name:'Modo de envío de Royal'})
    expect(within(mode).getByRole('button',{name:'Enviar número'})).toHaveAttribute('aria-pressed','true')
    fireEvent.click(within(mode).getByRole('button',{name:'Enviar link'}))
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/agents/royal/delivery',expect.objectContaining({method:'PATCH',body:JSON.stringify({delivery_mode:'link'})})))
    expect(await screen.findByText(/líneas activas sin link/)).toBeVisible()
    fireEvent.click(screen.getByRole('button',{name:'Editar Royal Línea 8'}))
    const modal=screen.getByRole('dialog')
    fireEvent.change(within(modal).getByLabelText('Link'),{target:{value:'https://example.com/royal8'}})
    fireEvent.change(within(modal).getByLabelText('Teléfono'),{target:{value:''}})
    expect(within(modal).getByLabelText('Teléfono')).not.toBeRequired()
    fireEvent.click(within(modal).getByRole('button',{name:'Guardar'}))
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/agents/royal/lines/line-8',expect.objectContaining({body:JSON.stringify({label:'Royal 8',phone:'',link_url:'https://example.com/royal8',is_active:true})})))
  })
  it('keeps the previous mode and reports a failed save',async()=>{
    render(<AgentsPage/>);const mode=await screen.findByRole('group',{name:'Modo de envío de Royal'})
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:'Reintentá'}),{status:500}))
    fireEvent.click(within(mode).getByRole('button',{name:'Enviar link'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Reintentá')
    expect(within(mode).getByRole('button',{name:'Enviar número'})).toHaveAttribute('aria-pressed','true')
  })
  it('does not fetch the directory or offer changes to operators',()=>{
    mocks.role='operator';render(<AgentsPage/>)
    expect(screen.getByRole('alert')).toHaveTextContent('Solo los administradores')
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByRole('button',{name:'Nuevo agente'})).not.toBeInTheDocument()
  })
})
