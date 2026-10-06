import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react')
  type Props = { open?: boolean; children?: React.ReactNode }
  return {
    Dialog: ({ open, children }: Props) => open ? h('div', { role: 'dialog' }, children) : null,
    DialogContent: ({ children }: Props) => h('div', null, children),
    DialogHeader: ({ children }: Props) => h('div', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
  }
})
import Page from '@/app/(protected)/automatizaciones/page'
import { CreateAutomationSchema, UpdateAutomationSchema } from '@/lib/schema'

const rule = {
  id: 'once-rule', name: 'Bono EXTRA', type: 'reply', trigger_type: 'keyword',
  trigger_config: { keywords: ['EXTRA', 'Mas info'], once_per_chat: true },
  action_config: { message: 'Mensaje actual del bono' }, is_active: true, priority: 1,
  description: null, created_by_name: 'Admin', created_at: '2026-10-02T12:00:00Z', updated_at: '2026-10-02T12:00:00Z',
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetch.mockImplementation(async (_url, init) => init?.method ? { ok: true } : { automations: [rule] })
})
afterEach(cleanup)

describe('once-per-chat automation setting', () => {
  it('shows the active setting and preserves it and both keywords when editing the message', async () => {
    render(<Page />)
    await screen.findByText('Una vez por chat')
    fireEvent.click(screen.getByTitle('Editar'))
    expect(screen.getByRole('checkbox', { name: 'Enviar esta respuesta solo una vez por chat' })).toBeChecked()
    fireEvent.change(screen.getByPlaceholderText(/Hola \{\{nombre\}\}/), { target: { value: 'Texto actualizado' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/automations/once-rule', expect.objectContaining({ method: 'PATCH' })))
    const saved = JSON.parse(mocks.fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')![1].body)
    expect(saved.trigger_config).toEqual(rule.trigger_config)
    expect(saved.action_config.message).toBe('Texto actualizado')
  })
  it('keeps legacy rules repeatable until enabled and saves an explicit toggle', async () => {
    mocks.fetch.mockImplementation(async (_url, init) => init?.method ? { ok: true } : { automations: [{ ...rule, trigger_config: { keywords: ['EXTRA', 'Mas info'] } }] })
    render(<Page />); await screen.findByText('Bono EXTRA')
    fireEvent.click(screen.getByTitle('Editar'))
    const checkbox = screen.getByRole('checkbox', { name: 'Enviar esta respuesta solo una vez por chat' })
    expect(checkbox).not.toBeChecked(); fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const saved = JSON.parse(mocks.fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')![1].body)
    expect(saved.trigger_config.once_per_chat).toBe(true)
  })
  it('preserves directory routing when the introduction is edited', async () => {
    mocks.fetch.mockImplementation(async (_url, init) => init?.method ? {ok:true} : {automations:[{...rule,action_config:{message:'Tu línea:',contact_line_directory:'ofizeus'}}]})
    render(<Page />); await screen.findByText('Bono EXTRA'); fireEvent.click(screen.getByTitle('Editar'))
    expect(screen.getByText(/Esta respuesta agrega automáticamente/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Hola \{\{nombre\}\}/), {target:{value:'Hola, esta es tu línea:'}})
    fireEvent.click(screen.getByRole('button',{name:'Guardar cambios'}))
    await waitFor(()=>expect(mocks.fetch.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true))
    const saved=JSON.parse(mocks.fetch.mock.calls.find(([,init])=>init?.method==='PATCH')![1].body)
    expect(saved.action_config).toEqual({message:'Hola, esta es tu línea:',contact_line_directory:'ofizeus'})
  })
  it('rejects non-boolean values instead of silently making the reply repeatable', () => {
    expect(CreateAutomationSchema.safeParse({ ...rule, trigger_config: { once_per_chat: 'true' } }).success).toBe(false)
    expect(UpdateAutomationSchema.safeParse({ trigger_config: { once_per_chat: 'false' } }).success).toBe(false)
    expect(UpdateAutomationSchema.safeParse({ trigger_config: { once_per_chat: false, keywords: ['EXTRA'] } }).success).toBe(true)
  })
})
