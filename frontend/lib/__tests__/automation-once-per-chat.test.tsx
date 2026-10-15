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
import { OPT_OUT_AUTOMATION } from '@/lib/opt-out-automation'

const rule = {
  id: 'once-rule', name: 'Bono EXTRA', type: 'reply', trigger_type: 'keyword',
  trigger_config: { keywords: ['EXTRA', 'Mas info'], once_per_chat: true },
  action_config: { message: 'Mensaje actual del bono' }, is_active: true, priority: 1,
  description: null, created_by_name: 'Admin', created_at: '2026-10-02T12:00:00Z', updated_at: '2026-10-02T12:00:00Z',
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetch.mockImplementation(async (url, init) => init?.method ? { ok: true } : url === '/api/agents' ? { agents: [{ code:'royal', name:'Royal' },{ code:'ofizeus', name:'Ofizeus' }] } : { automations: [rule] })
})
afterEach(cleanup)

describe('BAJA reply editor', () => {
  it('saves just the message, displays it when reopened and discards cancelled changes', async () => {
    mocks.fetch.mockImplementation(async (_url, init) => init?.method
      ? { ok: true, automation: { ...OPT_OUT_AUTOMATION, action_config: JSON.parse(init.body).action_config, updated_at: '2026-10-13T20:00:00Z' } }
      : { automations: [OPT_OUT_AUTOMATION] })
    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar mensaje' }))
    const field = screen.getByRole('textbox', { name: 'Mensaje de respuesta' })
    expect(field).toHaveValue(OPT_OUT_AUTOMATION.action_config.message)
    fireEvent.change(field, { target: { value: 'Disculpá las molestias. Ya estás dado de baja.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.fetch).toHaveBeenCalledWith('/api/automations/system-baja-confirmation', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action_config: { message: 'Disculpá las molestias. Ya estás dado de baja.' } }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Editar mensaje' }))
    expect(screen.getByLabelText('Mensaje de respuesta')).toHaveValue('Disculpá las molestias. Ya estás dado de baja.')
    fireEvent.change(screen.getByLabelText('Mensaje de respuesta'), { target: { value: 'Cambio sin guardar' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Editar mensaje' }))
    expect(screen.getByLabelText('Mensaje de respuesta')).toHaveValue('Disculpá las molestias. Ya estás dado de baja.')
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1)
  })
  it('rejects a blank reply and preserves the draft after a save failure', async () => {
    mocks.fetch.mockImplementation(async (_url, init) => { if (init?.method) throw Error('No se pudo guardar'); return { automations: [OPT_OUT_AUTOMATION] } })
    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar mensaje' }))
    fireEvent.change(screen.getByLabelText('Mensaje de respuesta'), { target: { value: ' ' } })
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Mensaje de respuesta'), { target: { value: 'Disculpá las molestias.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar')
    expect(screen.getByLabelText('Mensaje de respuesta')).toHaveValue('Disculpá las molestias.')
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeEnabled()
  })
})

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
    expect(screen.getByText(/donde quieras mostrar el número/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Hola \{\{nombre\}\}/), {target:{value:'Hola, esta es tu línea:'}})
    fireEvent.click(screen.getByRole('button',{name:'Guardar cambios'}))
    await waitFor(()=>expect(mocks.fetch.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true))
    const saved=JSON.parse(mocks.fetch.mock.calls.find(([,init])=>init?.method==='PATCH')![1].body)
    expect(saved.action_config).toEqual({message:'Hola, esta es tu línea:',contact_line_directory:'ofizeus'})
  })
  it('requires an explicit agent when adding {{2}} and previews a synthetic number', async()=>{
    render(<Page/>);await screen.findByText('Bono EXTRA');fireEvent.click(screen.getByTitle('Editar'))
    fireEvent.change(screen.getByPlaceholderText(/Hola \{\{nombre\}\}/),{target:{value:'Lines designada: {{2}}'}})
    expect(screen.getByLabelText('Vista previa de línea asignada')).toHaveTextContent('Lines designada: 549 | 1100 | 000000')
    fireEvent.click(screen.getByRole('button',{name:'Guardar cambios'}))
    expect(await screen.findByText('Elegí el agente de la línea asignada para usar {{2}}')).toBeInTheDocument()
    expect(mocks.fetch.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false)
    await screen.findByRole('option',{name:'Royal'})
    fireEvent.change(screen.getByLabelText('Agente de la línea asignada'),{target:{value:'royal'}})
    fireEvent.click(screen.getByRole('button',{name:'Guardar cambios'}))
    await waitFor(()=>expect(mocks.fetch.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true))
    const saved=JSON.parse(mocks.fetch.mock.calls.find(([,init])=>init?.method==='PATCH')![1].body)
    expect(saved.action_config).toEqual({message:'Lines designada: {{2}}',contact_line_directory:'royal'})
  })
  it('preserves Royal when editing its message', async()=>{
    mocks.fetch.mockImplementation(async (url,init)=>init?.method?{ok:true}:url==='/api/agents'?{agents:[{code:'royal',name:'Royal'}]}:{automations:[{...rule,action_config:{message:'Tu línea: {{2}}',contact_line_directory:'royal'}}]})
    render(<Page/>);await screen.findByText('Bono EXTRA');fireEvent.click(screen.getByTitle('Editar'))
    expect(screen.getByLabelText('Agente de la línea asignada')).toHaveValue('royal')
    fireEvent.change(screen.getByPlaceholderText(/Hola \{\{nombre\}\}/),{target:{value:'Contactá a {{2}}'}})
    fireEvent.click(screen.getByRole('button',{name:'Guardar cambios'}))
    await waitFor(()=>expect(mocks.fetch.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true))
    const saved=JSON.parse(mocks.fetch.mock.calls.find(([,init])=>init?.method==='PATCH')![1].body)
    expect(saved.action_config).toEqual({message:'Contactá a {{2}}',contact_line_directory:'royal'})
  })
  it('validates directory codes without losing other action fields',()=>{
    expect(UpdateAutomationSchema.parse({action_config:{message:'{{2}}',contact_line_directory:' Royal '}}).action_config).toEqual({message:'{{2}}',contact_line_directory:'royal'})
    for(const value of ['',{},'royal / ofizeus']) expect(UpdateAutomationSchema.safeParse({action_config:{contact_line_directory:value}}).success).toBe(false)
  })
  it('rejects non-boolean values instead of silently making the reply repeatable', () => {
    expect(CreateAutomationSchema.safeParse({ ...rule, trigger_config: { once_per_chat: 'true' } }).success).toBe(false)
    expect(UpdateAutomationSchema.safeParse({ trigger_config: { once_per_chat: 'false' } }).success).toBe(false)
    expect(UpdateAutomationSchema.safeParse({ trigger_config: { once_per_chat: false, keywords: ['EXTRA'] } }).success).toBe(true)
  })
})
