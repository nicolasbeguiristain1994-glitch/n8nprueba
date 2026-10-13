import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '@/lib/scoring/conversation-scoring'
const message:Message={id:'123',phone_number:'5491100000001',message_body:'[image]',direction:'inbound',status:'received',created_at:'2026-10-10T12:00:00Z',media_type:'image',media_url:'/api/conversations/media?message=123'}
afterEach(cleanup)
describe('message media',()=>{
  it('shows an image with its caption and opens an accessible enlarged view',async()=>{
    render(<MessageBubble m={{...message,media_caption:'Mi comprobante'}} />)
    expect(screen.getByText('Mi comprobante')).toBeInTheDocument()
    expect(screen.queryByText('[image]')).not.toBeInTheDocument()
    fireEvent.load(screen.getByAltText('Imagen'))
    fireEvent.click(screen.getByRole('button',{name:'Ampliar imagen'}))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByAltText('Imagen ampliada')).toHaveAttribute('src',message.media_url)
    fireEvent.click(screen.getByRole('button',{name:'Cerrar'}))
  })
  it('renders stickers, including existing outgoing previews',()=>{
    const {rerender}=render(<MessageBubble m={{...message,media_type:'sticker',message_body:'[sticker]'}} />)
    expect(screen.getByAltText('Sticker')).toHaveAttribute('src',message.media_url)
    rerender(<MessageBubble m={{...message,media_type:'sticker',media_url:undefined,sticker_preview:'data:image/webp;base64,abc',direction:'outbound'}} />)
    expect(screen.getByAltText('Sticker')).toHaveAttribute('src','data:image/webp;base64,abc')
  })
  it('offers a retry for unavailable media without losing the caption or sending anything',()=>{
    render(<MessageBubble m={{...message,media_caption:'Detalle'}} />)
    fireEvent.error(screen.getByAltText('Imagen'))
    expect(screen.getByText('Imagen no disponible')).toBeInTheDocument()
    expect(screen.getByText('Detalle')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Reintentar'}))
    expect(screen.getByAltText('Imagen')).toHaveAttribute('src',message.media_url+'&retry=1')
  })
  it('keeps ordinary text unchanged',()=>{
    render(<MessageBubble m={{...message,media_url:undefined,message_body:'Hola'}} />)
    expect(screen.getByText('Hola')).toBeInTheDocument();expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
  it('plays audio with native controls without treating it as an image or loading it upfront',()=>{
    render(<MessageBubble m={{...message,media_type:'audio',message_body:'[audio]'}} />)
    const audio=screen.getByLabelText('Reproducir audio del mensaje')
    expect(audio.tagName).toBe('AUDIO')
    expect(audio).toHaveAttribute('controls');expect(audio).toHaveAttribute('preload','none')
    expect(audio).toHaveAttribute('src',message.media_url)
    expect(audio).not.toHaveAttribute('autoplay')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByText('[audio]')).not.toBeInTheDocument()
    fireEvent.waiting(audio);expect(screen.getByText('Cargando audio…')).toBeInTheDocument()
    fireEvent.playing(audio);expect(screen.queryByText('Cargando audio…')).not.toBeInTheDocument()
  })
  it('lets the user retry an expired or failed audio request',()=>{
    render(<MessageBubble m={{...message,media_type:'audio',message_body:'[audio]'}} />)
    fireEvent.error(screen.getByLabelText('Reproducir audio del mensaje'))
    expect(screen.getByRole('status')).toHaveTextContent('No se pudo reproducir el audio')
    fireEvent.click(screen.getByRole('button',{name:'Reintentar audio'}))
    expect(screen.getByLabelText('Reproducir audio del mensaje')).toHaveAttribute('src',message.media_url+'&retry=1')
  })
  it('explains unavailable historical audio without a broken player',()=>{
    render(<MessageBubble m={{...message,media_type:undefined,media_url:undefined,message_body:'[audio]'}} />)
    expect(screen.getByRole('status')).toHaveTextContent('No se encontró un archivo para este audio')
    expect(screen.queryByLabelText('Reproducir audio del mensaje')).not.toBeInTheDocument()
  })
})
