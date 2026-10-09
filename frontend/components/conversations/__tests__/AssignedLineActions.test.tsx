import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {AssignedLineActions} from '../AssignedLineActions'
import {ConversationHeader} from '../ConversationHeader'
import {ConversationItem} from '../ConversationItem'
import type {Conv} from '@/lib/scoring/conversation-scoring'
const conv:Conv={phone_number:'5491100000001',first_name:'Ana',last_message:'Hola',last_direction:'inbound',last_status:'received',last_at:'2026-10-09',agent:'royal',linea:8,linea_sub:'a',assigned_line:{label:'Royal 8A',phone:'+5491112345678'}}
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('assigned line in conversations',()=>{
  it('shows the assignment in both list and header',()=>{
    render(<><ConversationItem conv={conv} isSelected={false} onClick={vi.fn()}/><ConversationHeader conv={conv} phone={conv.phone_number}/></>)
    expect(screen.getAllByText('Línea 8A')).toHaveLength(2)
  })
  it('copies only the number and inserts a draft without sending',async()=>{
    const copy=vi.fn().mockResolvedValue(undefined),insert=vi.fn()
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}})
    render(<AssignedLineActions conv={conv} onInsert={insert}/>)
    fireEvent.click(screen.getByRole('button',{name:'Copiar número de la línea'}))
    await waitFor(()=>expect(copy).toHaveBeenCalledWith('+5491112345678'))
    expect(insert).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'Pegar en respuesta'}))
    expect(insert).toHaveBeenCalledWith('Tu línea designada es Royal 8A: +5491112345678')
    expect(screen.queryByRole('button',{name:/Enviar/})).not.toBeInTheDocument()
  })
  it.each([{...conv,assigned_line:null},{...conv,line_assignment_ambiguous:true},{...conv,linea:null,assigned_line:null}])('does not offer a number for unavailable or ambiguous assignments',c=>{
    render(<AssignedLineActions conv={c} onInsert={vi.fn()}/>)
    expect(screen.queryByRole('button',{name:'Pegar en respuesta'})).not.toBeInTheDocument()
    expect(screen.queryByText('+5491112345678')).not.toBeInTheDocument()
  })
  it('keeps inserting available if the browser denies clipboard access',async()=>{
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockRejectedValue(Error('denied'))}})
    const insert=vi.fn();render(<AssignedLineActions conv={conv} onInsert={insert}/>)
    fireEvent.click(screen.getByRole('button',{name:'Copiar número de la línea'}))
    expect(await screen.findByRole('status')).toHaveTextContent('No se pudo copiar')
    fireEvent.click(screen.getByRole('button',{name:'Pegar en respuesta'}))
    expect(insert).toHaveBeenCalledOnce()
  })
})
