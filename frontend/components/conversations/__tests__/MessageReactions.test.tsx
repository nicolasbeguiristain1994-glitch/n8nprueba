import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '@/lib/scoring/conversation-scoring'

const message:Message={id:'00000000-0000-4000-8000-000000000001',phone_number:'5491100000001',message_body:'Hola',direction:'inbound',status:'received',created_at:new Date().toISOString(),can_react:true,reactions:[]}
const fetchMock=vi.fn()
beforeEach(()=>{fetchMock.mockReset().mockResolvedValue(Response.json({ok:true}));vi.stubGlobal('fetch',fetchMock)})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('message reactions',()=>{
  it('opens an accessible selector and sends the selected emoji for this message',async()=>{
    const refresh=vi.fn()
    render(<MessageBubble m={message} onReactionChanged={refresh}/>)
    fireEvent.click(screen.getByRole('button',{name:'Reaccionar al mensaje'}))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Reaccionar con 👍'}))
    await waitFor(()=>expect(refresh).toHaveBeenCalledOnce())
    const [url,init]=fetchMock.mock.calls[0]
    expect(url).toBe('/api/conversations/reactions')
    expect(JSON.parse(init.body)).toMatchObject({messageId:message.id,emoji:'👍',requestId:expect.any(String)})
    expect(screen.getByRole('button',{name:'Quitar nuestra reacción 👍'})).toBeInTheDocument()
  })
  it('removes our reaction without removing the contact reaction',async()=>{
    render(<MessageBubble m={{...message,reactions:[{actor:'self',emoji:'❤️'},{actor:'contact',emoji:'🔥'}]}}/>)
    fireEvent.click(screen.getByRole('button',{name:'Quitar nuestra reacción ❤️'}))
    await waitFor(()=>expect(screen.queryByRole('button',{name:'Quitar nuestra reacción ❤️'})).not.toBeInTheDocument())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).emoji).toBe('')
    expect(screen.getByLabelText('Reacción del contacto 🔥')).toBeInTheDocument()
  })
  it('keeps the previous emoji and displays a provider rejection',async()=>{
    fetchMock.mockResolvedValue(Response.json({error:'La ventana está cerrada.'},{status:409}))
    render(<MessageBubble m={{...message,reactions:[{actor:'self',emoji:'❤️'}]}}/>)
    fireEvent.click(screen.getByRole('button',{name:'Reaccionar al mensaje'}))
    fireEvent.click(await screen.findByRole('button',{name:'Reaccionar con 😂'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('La ventana está cerrada.')
    expect(screen.getByRole('button',{name:'Quitar nuestra reacción ❤️'})).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:'Quitar nuestra reacción 😂'})).not.toBeInTheDocument()
  })
  it('allows more emojis and reflects a later server snapshot',async()=>{
    const {rerender}=render(<MessageBubble m={message}/>)
    fireEvent.click(screen.getByRole('button',{name:'Reaccionar al mensaje'}))
    fireEvent.click(await screen.findByRole('button',{name:'Más emojis'}))
    fireEvent.click(screen.getByRole('button',{name:'Elegir 🎰'}))
    expect(await screen.findByRole('button',{name:'Quitar nuestra reacción 🎰'})).toBeInTheDocument()
    rerender(<MessageBubble m={{...message,reactions:[{actor:'self',emoji:'✅'}]}}/>)
    expect(screen.queryByRole('button',{name:'Quitar nuestra reacción 🎰'})).not.toBeInTheDocument()
    expect(screen.getByRole('button',{name:'Quitar nuestra reacción ✅'})).toBeInTheDocument()
  })
  it('displays incoming reactions to read-only users without send controls',()=>{
    render(<MessageBubble m={{...message,can_react:false,reactions:[{actor:'contact',emoji:'👍'}]}}/>)
    expect(screen.queryByRole('button',{name:'Reaccionar al mensaje'})).not.toBeInTheDocument()
    expect(screen.getByLabelText('Reacción del contacto 👍')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
