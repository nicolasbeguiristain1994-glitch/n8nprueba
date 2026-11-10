import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreateConversationContact } from '../CreateConversationContact'
import { ConversationHeader } from '../ConversationHeader'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Save an unknown conversation sender', () => {
  it('opens from the chat header without navigating to Contacts', () => {
    const open = vi.fn()
    const { rerender } = render(<ConversationHeader phone="5491100000001" conv={undefined} onCreateContact={open} />)
    fireEvent.click(screen.getByRole('button', { name: 'Crear contacto' }))
    expect(open).toHaveBeenCalledOnce()
    expect(screen.queryByRole('link', { name: 'Crear contacto' })).not.toBeInTheDocument()
    rerender(<ConversationHeader phone="5491100000001" conv={undefined} />)
    expect(screen.queryByRole('button', { name: 'Crear contacto' })).not.toBeInTheDocument()
  })

  it('prefills the phone, saves in the current inbox and updates the open conversation', async () => {
    const contact = { contact_id: 'new-contact', first_name: 'Ana', last_name: 'Pérez', segment: null }
    const fetch = vi.fn().mockResolvedValue(Response.json({ contact }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const onCreated = vi.fn(), onClose = vi.fn()
    render(<CreateConversationContact phone="5491100000001" agent="all" onCreated={onCreated} onClose={onClose} />)
    expect(screen.getByLabelText('Teléfono')).toHaveValue('+5491100000001')
    expect(screen.getByLabelText('Teléfono')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Guardar contacto' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Nombre y apellido'), { target: { value: 'Ana Pérez' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contacto' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(contact))
    expect(fetch).toHaveBeenCalledWith('/api/conversations/5491100000001/contact?agent=all', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Ana Pérez' }) }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows a failed save, preserves the name and allows retry without duplicate submissions', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(Response.json({ contact: { contact_id: 'saved' } }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const onCreated = vi.fn(), onClose = vi.fn()
    render(<CreateConversationContact phone="5491100000001" agent="royal" onCreated={onCreated} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Nombre y apellido'), { target: { value: 'Ana' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contacto' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardando…' }))
    expect(fetch).toHaveBeenCalledOnce()
    finish(Response.json({ error: 'No se pudo guardar. Intentá nuevamente.' }, { status: 500 }))
    await screen.findByRole('alert')
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Nombre y apellido')).toHaveValue('Ana')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contacto' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
