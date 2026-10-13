import userEvent from '@testing-library/user-event'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { role: 'admin' } }) }))
import TemplatesPage from '@/app/(protected)/templates/page'

const accounts = [{ waba_id: '111111', name: 'Nexus', connected: true, line_count: 3 }, { waba_id: '222222', name: 'Lexora', connected: true, line_count: 2 }]
const saved = {
  waba_id: '111111',
  id: '11111111-1111-4111-8111-111111111111', name: 'aviso_soporte', category: 'UTILITY', language: 'es_AR',
  status: 'BORRADOR', whatsapp_template_id: null, rejection_reason: null, usage_count: 0, last_used_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  components: [{ type: 'BODY', text: 'Hola {{1}}, tu consulta {{2}} fue registrada.', example: { body_text: [['Ana', 'A-1']] } }],
}
const writeCalls: Array<{ url: string; method: string; body: Record<string, any> }> = []
let writeResponse: () => Response

function mockApi() {
  writeCalls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(JSON.stringify({ templates: [saved], accounts }), { status: 200 })
    writeCalls.push({ url, method, body: JSON.parse(String(init?.body)) })
    return writeResponse()
  }))
}
const writes = () => writeCalls
const example = (n: number) => screen.getByLabelText(`Ejemplo para {{${n}}}`) as HTMLInputElement
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Guardar plantilla' }))

beforeEach(() => { writeResponse = () => new Response(JSON.stringify({ ok: true, id: saved.id }), { status: 200 }); mockApi() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function openNew() {
  render(<TemplatesPage />)
  await screen.findByText('aviso_soporte')
  fireEvent.click(screen.getByRole('button', { name: /Nueva plantilla/ }))
  fireEvent.click(screen.getByRole('combobox', { name: 'Cuenta de WhatsApp' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Nexus · 111111' }))
  fireEvent.change(screen.getByLabelText(/Nombre/), { target: { value: 'Aviso Nuevo' } })
  fireEvent.change(screen.getByLabelText(/Cuerpo del mensaje/), { target: { value: 'Gracias por escribir a soporte.' } })
}

describe('templates editor', () => {
  it('keeps unsupported copied components out of the lossy local editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accounts, templates: [{ ...saved,
      components: [...saved.components, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Copiar código' }] }],
    }] }))))
    render(<TemplatesPage />)
    fireEvent.click(await screen.findByTitle('Ver plantilla'))
    expect(screen.queryByTitle('Editar')).not.toBeInTheDocument()
    expect(screen.getByText(/Se conserva completo/)).toBeInTheDocument()
    expect(writes()).toEqual([])
  })

  it('loads saved variable examples on edit and sends them back on save', async () => {
    render(<TemplatesPage />)
    fireEvent.click(await screen.findByTitle('Editar'))
    expect(example(1).value).toBe('Ana')
    expect(example(2).value).toBe('A-1')
    fireEvent.change(example(2), { target: { value: 'A-2' } })
    save()
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ url: `/api/templates/${saved.id}`, method: 'PATCH' })
    expect(writes()[0].body.components[0].example).toEqual({ body_text: [['Ana', 'A-2']] })
    expect(writes()[0].body.language).toBe('es_AR')
  })

  it('copies into a different account as a draft without transferring approval', async () => {
    render(<TemplatesPage />)
    fireEvent.click(await screen.findByTitle('Copiar a otra cuenta'))
    expect((screen.getByLabelText('Nombre de la copia') as HTMLInputElement).value).toBe(saved.name)
    fireEvent.click(screen.getByRole('combobox', { name: 'Cuenta de destino' }))
    expect(screen.queryByRole('option', { name: 'Nexus · 111111' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('option', { name: 'Lexora · 222222' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar copia como borrador' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ url: `/api/templates/${saved.id}/copy`, method: 'POST', body: { waba_id: '222222', name: saved.name } })
    expect(await screen.findByRole('status')).toHaveTextContent('borrador en Lexora')
  })

  it('filters templates by account and displays account ownership', async () => {
    render(<TemplatesPage />)
    await screen.findByText(saved.name)
    expect(screen.getByRole('columnheader', { name: 'Cuenta' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'Filtrar por cuenta' }))
    await user.click(await screen.findByRole('option', { name: 'Lexora · 222222' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/templates?waba_id=222222'))
  })

  it('asks for missing examples instead of inventing them', async () => {
    await openNew()
    fireEvent.change(screen.getByLabelText(/Cuerpo del mensaje/), { target: { value: 'Hola {{1}}' } })
    save()
    expect(await screen.findByText('Completá el ejemplo de {{1}}.')).toBeInTheDocument()
    expect(writes()).toEqual([])
  })

  it('flags an empty enabled button and ignores buttons once the section is disabled', async () => {
    await openNew()
    const toggle = screen.getByLabelText('Botones (máx. 3)')
    fireEvent.click(toggle)
    save()
    expect(await screen.findByText('Escribí el texto del botón.')).toBeInTheDocument()
    expect(writes()).toEqual([])

    fireEvent.click(toggle)
    save()
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toEqual({
      waba_id: '111111', name: 'Aviso Nuevo', category: 'MARKETING', language: 'es',
      components: [{ type: 'BODY', text: 'Gracias por escribir a soporte.' }],
    })
  })

  it('shows field messages from the API instead of a generic failure', async () => {
    writeResponse = () => new Response(JSON.stringify({ error: 'Validation failed', issues: [{ path: 'name', message: 'Nombre no disponible.' }] }), { status: 400 })
    await openNew()
    save()
    expect(await screen.findByText('Nombre no disponible.')).toBeInTheDocument()
    expect(screen.queryByText(/Validation failed/)).not.toBeInTheDocument()
  })

  it('does not show a raw internal error', async () => {
    writeResponse = () => new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 })
    await openNew()
    save()
    expect(await screen.findByText(/No se pudo guardar la plantilla/)).toBeInTheDocument()
    expect(screen.queryByText('Internal server error')).not.toBeInTheDocument()
  })

  it('widens the dialog at the same breakpoint as the base width and stacks columns on mobile', async () => {
    await openNew()
    const dialog = document.querySelector('[data-slot="dialog-content"]')!
    expect(dialog.className).toContain('sm:max-w-5xl')
    expect(dialog.className).not.toContain('sm:max-w-sm')
    expect(dialog.querySelector('.grid-cols-1.md\\:grid-cols-2')).not.toBeNull()
  })
})
