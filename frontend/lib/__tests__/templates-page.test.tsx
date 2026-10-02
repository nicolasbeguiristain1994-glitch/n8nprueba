import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { role: 'admin' } }) }))
import TemplatesPage from '@/app/(protected)/templates/page'

const saved = {
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
    if (method === 'GET') return new Response(JSON.stringify({ templates: [saved] }), { status: 200 })
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
  fireEvent.change(screen.getByLabelText(/Nombre/), { target: { value: 'Aviso Nuevo' } })
  fireEvent.change(screen.getByLabelText(/Cuerpo del mensaje/), { target: { value: 'Gracias por escribir a soporte.' } })
}

describe('templates editor', () => {
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

  it('keeps examples when duplicating', async () => {
    writeResponse = () => new Response(JSON.stringify({ id: 'new' }), { status: 201 })
    render(<TemplatesPage />)
    fireEvent.click(await screen.findByTitle('Duplicar'))
    expect((screen.getByLabelText(/Nombre/) as HTMLInputElement).value).toBe('aviso_soporte_copia')
    save()
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ url: '/api/templates', method: 'POST' })
    expect(writes()[0].body.components).toEqual(saved.components)
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
      name: 'Aviso Nuevo', category: 'MARKETING', language: 'es',
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
