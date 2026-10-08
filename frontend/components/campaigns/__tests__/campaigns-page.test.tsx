import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn() }))
const currentUser = vi.hoisted(() => ({ value: { user: { role: 'admin', id: 'owner' }, permissions: {} as Record<string, string[]> } }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }))

// Primitivas base-ui reemplazadas por equivalentes DOM simples para poder interactuar en happy-dom
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react')
  type P = { open?: boolean; children?: React.ReactNode }
  return {
    Dialog: ({ open, children }: P) => (open ? h('div', { role: 'dialog' }, children) : null),
    DialogContent: ({ children }: P) => h('div', null, children),
    DialogHeader: ({ children }: P) => h('div', null, children),
    DialogTitle: ({ children }: P) => h('h2', null, children),
    DialogDescription: ({ children }: P) => h('p', null, children),
  }
})
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const h = React.createElement
  const Ctx = React.createContext<(v: string) => void>(() => {})
  type P = { children?: React.ReactNode; value?: string; disabled?: boolean; onValueChange?: (v: string) => void }
  return {
    Select: ({ onValueChange, children }: P) => h(Ctx.Provider, { value: (v: string) => onValueChange?.(v) }, children),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: P) => h('div', null, children),
    SelectItem: function SelectItem({ value, disabled, children }: P) {
      const pick = React.useContext(Ctx)
      return h('button', { type: 'button', role: 'option', 'aria-selected': false, disabled, onClick: () => pick(value as string) }, children)
    },
  }
})
vi.mock('@/components/ui/input', async () => {
  const { createElement: h } = await import('react')
  return { Input: (props: Record<string, unknown>) => h('input', props) }
})

import { fetchJson } from '@/lib/fetchJson'
import Page from '@/app/(protected)/campaigns/page'

const TPL_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const TEMPLATES = [
  {
    id: TPL_ID, name: 'promo_bienvenida', language: 'es_AR', status: 'APROBADA', waba_id: '1029384756',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hola {{1}}, tenés {{2}} de bono' },
      { type: 'FOOTER', text: 'Casino' },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', text: 'Ver promo', url: 'https://example.com/p/{{1}}' },
        { type: 'QUICK_REPLY', text: 'No me interesa' },
      ] },
    ],
  },
  {
    id: '7a1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', name: 'sin_waba', language: 'es', status: 'APROBADA', waba_id: null,
    components: [{ type: 'BODY', text: 'Hola' }],
  },
  {
    id: '8b1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', name: 'cupon_codigo', language: 'es', status: 'APROBADA', waba_id: '1029384756',
    components: [
      { type: 'BODY', text: 'Tu cupón está listo' },
      { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Copiar código' }] },
    ],
  },
]

function makeCampaign(over: Record<string, unknown> = {}) {
  return {
    id: 'c-a', name: 'Promo Mayo', message: 'Hola', messages: ['Hola'], status: 'draft',
    scheduled_at: null as string | null, completed_at: null,
    total_targets: 0, total_sent: 0, total_delivered: 0, total_read: 0, total_failed: 0, total_skipped: 0,
    read_rate: 0, delivery_rate: 0, list_name: null, list_id: null, prospect_list_id: null, prospect_list_name: null,
    antiblock_delay_min: 3, antiblock_delay_max: 8, personalize_name: true, use_multi_line: false,
    created_at: '2026-09-01T12:00:00Z', pause_reason: null, processor_locked_at: null,
    ...over,
  }
}

type Handler = () => Promise<unknown>
function routeFetchJson(campaigns: Handler, templates: Handler = () => Promise.resolve({ templates: TEMPLATES })) {
  vi.mocked(fetchJson).mockImplementation((input: RequestInfo) => {
    const u = String(input)
    if (u === '/api/campaigns') return campaigns() as Promise<never>
    if (u.startsWith('/api/lists')) return Promise.resolve({ lists: [{ id: 'l1', name: 'VIP', contact_count: 3 }] }) as Promise<never>
    if (u.startsWith('/api/prospect-lists')) return Promise.resolve({ lists: [] }) as Promise<never>
    if (u.startsWith('/api/templates')) return templates() as Promise<never>
    return Promise.reject(new Error(`URL inesperada ${u}`))
  })
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url, init]) => url === '/api/campaigns' && init?.method === 'POST')
  expect(call).toBeDefined()
  return JSON.parse(call![1].body as string)
}

const nextStep = () => fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
const chooseAudience = () => {
  fireEvent.click(screen.getByRole('option', { name: /VIP/ }))
  nextStep()
}
const reviewContent = () => { nextStep(); nextStep() }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { vi.clearAllMocks(); currentUser.value = { user: { role: 'admin', id: 'owner' }, permissions: {} } })

describe('Campañas — plantillas', () => {
  it('vincula {{1}} al nombre de cada contacto y muestra Pablo sólo como ejemplo', async () => {
    routeFetchJson(
      () => Promise.resolve({ campaigns: [], scheduler_enabled: false }),
      () => Promise.resolve({ templates: [{
        id: TPL_ID, name: 'regalo3000', language: 'es_AR', status: 'APROBADA', waba_id: '1029384756',
        components: [{ type: 'BODY', text: 'Hola {{1}} 👋 ¡Tenés $3.000 de regalo para tu próxima compra! 🎁 Respondé EXTRA y te lo acreditamos en tu cuenta al instante ✅' }],
      }] }),
    )
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'nueva', status: 'draft' }))
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Regalo personalizado' } })
    chooseAudience()
    fireEvent.click(screen.getByRole('button', { name: /Usar plantilla aprobada/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'regalo3000 · es_AR' }))

    const input = screen.getByLabelText('Parámetro {{1}} del cuerpo')
    fireEvent.change(input, { target: { value: 'nombre' } })
    expect(screen.getByText(/Hola nombre 👋/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Usar nombre del contacto en {{1}}' }))
    expect(input).toHaveValue('{{first_name}}')
    expect(screen.getByText('Hola Pablo 👋 ¡Tenés $3.000 de regalo para tu próxima compra! 🎁 Respondé EXTRA y te lo acreditamos en tu cuenta al instante ✅')).toBeInTheDocument()
    expect(screen.getByText('Pablo es un nombre de ejemplo. Cada contacto recibe el suyo.')).toBeInTheDocument()

    reviewContent()
    fireEvent.click(screen.getByRole('button', { name: /Guardar campaña/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(postedBody(fetchMock)).toMatchObject({
      message_type: 'template', template_id: TPL_ID, template_params: { body: ['{{first_name}}'] },
    })
  })

  it('envía la plantilla como template con parámetros y use_multi_line true, sin texto libre', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [], scheduler_enabled: false }))
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'nueva', status: 'draft' }))
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Bono bienvenida' } })
    chooseAudience()
    fireEvent.click(screen.getByRole('button', { name: /Usar plantilla aprobada/ }))

    const option = await screen.findByRole('option', { name: 'promo_bienvenida · es_AR' })
    // Sin WABA asociada no se ofrece
    expect(screen.queryByRole('option', { name: /sin_waba/ })).not.toBeInTheDocument()
    fireEvent.click(option)

    // El editor de texto libre / variantes no se usa como sustituto
    expect(screen.queryByText(/Agregar variante de mensaje/)).not.toBeInTheDocument()
    const advance = screen.getByRole('button', { name: 'Continuar' })
    fireEvent.click(advance)
    expect(screen.getByText(/Completá un mensaje/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Guardar campaña/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('URL del encabezado (imagen)'), { target: { value: 'https://cdn.example.com/promo.jpg' } })
    fireEvent.change(screen.getByLabelText('Parámetro {{1}} del cuerpo'), { target: { value: 'Juan' } })
    fireEvent.change(screen.getByLabelText('Parámetro {{2}} del cuerpo'), { target: { value: '$5.000' } })
    fireEvent.change(screen.getByLabelText(/Valor variable de la URL del botón "Ver promo"/), { target: { value: 'abc123' } })
    expect(screen.getByText('Hola Juan, tenés $5.000 de bono')).toBeInTheDocument()
    reviewContent()
    fireEvent.click(screen.getByRole('button', { name: /Guardar campaña/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = postedBody(fetchMock)
    expect(body).toMatchObject({
      name: 'Bono bienvenida',
      message_type: 'template',
      template_id: TPL_ID,
      use_multi_line: true,
      template_params: {
        body: ['Juan', '$5.000'],
        header: { type: 'image', link: 'https://cdn.example.com/promo.jpg' },
        buttons: [{ index: 0, sub_type: 'url', payload: 'abc123' }],
      },
    })
    expect(body).not.toHaveProperty('message')
    expect(body).not.toHaveProperty('messages')
    expect(body).not.toHaveProperty('media_url')
    expect(body.scheduled_at).toBeNull()
  })

  it('bloquea la creación e informa cuando la plantilla tiene componentes no compatibles', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [], scheduler_enabled: false }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Cupones' } })
    chooseAudience()
    fireEvent.click(screen.getByRole('button', { name: /Usar plantilla aprobada/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'cupon_codigo · es' }))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Esta plantilla no se puede usar en campañas todavía')
    expect(alert).toHaveTextContent('COPY_CODE')
    nextStep()
    expect(screen.queryByRole('button', { name: /Guardar campaña/ })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rechaza como el backend variables de cuerpo no consecutivas y URL dinámica fuera del final', async () => {
    routeFetchJson(
      () => Promise.resolve({ campaigns: [], scheduler_enabled: false }),
      () => Promise.resolve({ templates: [
        { id: 'tpl-hueco', name: 'hueco', language: 'es', status: 'APROBADA', waba_id: '1029384756',
          components: [{ type: 'BODY', text: 'Hola {{1}}, código {{3}}' }] },
        { id: 'tpl-url', name: 'url_media', language: 'es', status: 'APROBADA', waba_id: '1029384756',
          components: [
            { type: 'BODY', text: 'Hola' },
            { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Abrir', url: 'https://example.com/{{1}}/promo' }] },
          ] },
      ] }),
    )
    vi.stubGlobal('fetch', vi.fn())

    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Validación' } })
    chooseAudience()
    fireEvent.click(screen.getByRole('button', { name: /Usar plantilla aprobada/ }))

    fireEvent.click(await screen.findByRole('option', { name: 'hueco · es' }))
    expect(screen.getByRole('alert')).toHaveTextContent('variables no compatibles')
    expect(screen.queryByLabelText(/Parámetro \{\{3\}\} del cuerpo/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Guardar campaña/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'url_media · es' }))
    expect(screen.getByRole('alert')).toHaveTextContent('URL dinámica no compatible')
    expect(screen.queryByRole('button', { name: /Guardar campaña/ })).not.toBeInTheDocument()
  })
})

describe('Campañas — sincronizar plantillas desde Meta', () => {
  const openTemplateMode = async () => {
    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Prueba plantilla' } })
    chooseAudience()
    fireEvent.click(screen.getByRole('button', { name: /Usar plantilla aprobada/ }))
  }
  const syncCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.filter(([url]) => url === '/api/templates/sync-cloud')

  it('sin plantillas locales, sincroniza sólo al pulsar el botón y recarga las aprobadas', async () => {
    let tplCalls = 0
    routeFetchJson(
      () => Promise.resolve({ campaigns: [], scheduler_enabled: false }),
      () => Promise.resolve({ templates: ++tplCalls === 1 ? [] : TEMPLATES }),
    )
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === '/api/templates/sync-cloud'
      ? Promise.resolve(jsonResponse({ ok: true, synced: 3, accounts: 1 }))
      : Promise.reject(new Error(`URL inesperada ${url}`)))
    vi.stubGlobal('fetch', fetchMock)

    await openTemplateMode()
    expect(await screen.findByRole('option', { name: /No hay plantillas aprobadas/ })).toBeDisabled()
    expect(screen.getByText(/No hay plantillas locales/)).toBeInTheDocument()
    // Abrir el modal / activar plantillas no dispara la sincronización
    expect(syncCalls(fetchMock)).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /Sincronizar desde Meta/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('Se sincronizaron 3 plantillas de 1 cuentas WABA')
    expect(syncCalls(fetchMock)).toHaveLength(1)
    const [, init] = syncCalls(fetchMock)[0]
    expect(init).toMatchObject({ method: 'POST' })
    expect(init).not.toHaveProperty('body')

    expect(await screen.findByRole('option', { name: 'promo_bienvenida · es_AR' })).toBeInTheDocument()
    expect(vi.mocked(fetchJson).mock.calls.filter(([u]) => String(u) === '/api/templates?status=APROBADA')).toHaveLength(2)
  })

  it('sincronización parcial (502) muestra el error y recarga el catálogo', async () => {
    let tplCalls = 0
    routeFetchJson(
      () => Promise.resolve({ campaigns: [], scheduler_enabled: false }),
      () => Promise.resolve({ templates: ++tplCalls === 1 ? [] : TEMPLATES }),
    )
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ error: 'Una cuenta WABA no respondió', synced: 2 }, 502)))
    vi.stubGlobal('fetch', fetchMock)

    await openTemplateMode()
    await screen.findByRole('option', { name: /No hay plantillas aprobadas/ })
    fireEvent.click(screen.getByRole('button', { name: /Sincronizar desde Meta/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Una cuenta WABA no respondió')
    expect(alert).toHaveTextContent('sincronización parcial: 2 plantillas importadas')
    expect(await screen.findByRole('option', { name: 'promo_bienvenida · es_AR' })).toBeInTheDocument()
  })

  it('un error total muestra el mensaje sin recargar el catálogo', async () => {
    routeFetchJson(
      () => Promise.resolve({ campaigns: [], scheduler_enabled: false }),
      () => Promise.resolve({ templates: [] }),
    )
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'Sin permiso' }, 403))))

    await openTemplateMode()
    await screen.findByRole('option', { name: /No hay plantillas aprobadas/ })
    fireEvent.click(screen.getByRole('button', { name: /Sincronizar desde Meta/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Sin permiso')
    expect(vi.mocked(fetchJson).mock.calls.filter(([u]) => String(u).startsWith('/api/templates'))).toHaveLength(1)
  })
})

describe('Campañas — errores de carga', () => {
  it('un fallo inicial muestra error con reintento y no "sin campañas"', async () => {
    let calls = 0
    routeFetchJson(() => (++calls === 1
      ? Promise.reject(new Error('HTTP 500: error'))
      : Promise.resolve({ campaigns: [makeCampaign()], scheduler_enabled: false })))

    render(<Page />)
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar las campañas')
    expect(screen.queryByText('No hay campañas todavía')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText('Promo Mayo')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('un refresco fallido conserva las campañas ya cargadas', async () => {
    let calls = 0
    routeFetchJson(() => (++calls === 1
      ? Promise.resolve({ campaigns: [makeCampaign()], scheduler_enabled: false })
      : Promise.reject(new Error('HTTP 503: caído'))))

    render(<Page />)
    await screen.findByText('Promo Mayo')
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Se muestran los últimos datos cargados')
    expect(screen.getByText('Promo Mayo')).toBeInTheDocument()
    expect(screen.getByText('1 campañas')).toBeInTheDocument()
  })

  it('descarta la respuesta tardía del detalle de otra campaña', async () => {
    routeFetchJson(() => Promise.resolve({
      campaigns: [makeCampaign(), makeCampaign({ id: 'c-b', name: 'Promo Junio' })],
      scheduler_enabled: false,
    }))
    let finishA: (r: Response) => void = () => {}
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/campaigns/c-a/contacts') return new Promise<Response>(r => { finishA = r })
      if (url === '/api/campaigns/c-b/contacts') return Promise.resolve(jsonResponse({ contacts: [
        { id: 'cc-b', contact_id: 'k2', prospect_id: null, first_name: 'Beto', last_name: 'Dos', phone_number: '5491100000002',
          msg_status: 'sent', sent_at: null, delivered_at: null, read_at: null, failed_at: null, error_detail: null },
      ] }))
      return Promise.reject(new Error(`URL inesperada ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('Promo Junio')
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle de Promo Mayo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle de Promo Junio' }))
    expect(await screen.findByText('Beto Dos')).toBeInTheDocument()

    await act(async () => finishA(jsonResponse({ contacts: [
      { id: 'cc-a', contact_id: 'k1', prospect_id: null, first_name: 'Ana', last_name: 'Uno', phone_number: '5491100000001',
        msg_status: 'sent', sent_at: null, delivered_at: null, read_at: null, failed_at: null, error_detail: null },
    ] })))
    expect(screen.queryByText('Ana Uno')).not.toBeInTheDocument()
    expect(screen.getByText('Beto Dos')).toBeInTheDocument()
  })
})

describe('Campañas — programación', () => {
  const scheduled = (over = {}) => makeCampaign({ status: 'scheduled', scheduled_at: '2035-10-02T20:30:00.000Z', started_at: null, owned_by: 'owner', ...over })

  it('edita el horario en Argentina y conserva la campaña sin iniciar envíos', async () => {
    let campaign = scheduled()
    routeFetchJson(() => Promise.resolve({ campaigns: [campaign], scheduler_enabled: true }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/campaigns/c-a/schedule')
      expect(init?.method).toBe('PATCH')
      campaign = { ...campaign, scheduled_at: '2035-10-03T22:45:00.000Z' }
      return jsonResponse({ ok: true, scheduled_at: campaign.scheduled_at })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar horario de Promo Mayo' }))
    expect(screen.getByLabelText('Fecha de envío')).toHaveValue('2035-10-02')
    expect(screen.getByLabelText('Hora de envío')).toHaveValue('17:30')
    fireEvent.change(screen.getByLabelText('Fecha de envío'), { target: { value: '2035-10-03' } })
    fireEvent.change(screen.getByLabelText('Hora de envío'), { target: { value: '19:45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar horario' }))
    expect(await screen.findByText(/Horario actualizado:/)).toHaveTextContent('19:45')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      scheduled_at: '2035-10-03T19:45:00-03:00', expected_scheduled_at: '2035-10-02T20:30:00.000Z',
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Programado')).toBeInTheDocument()
  })

  it('rechaza una hora pasada antes de enviar cambios', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [scheduled({ scheduled_at: '2020-01-01T12:00:00Z' })], scheduler_enabled: true }))
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar horario de Promo Mayo' }))
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar horario' }).closest('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('fecha y hora futuras')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('conserva el formulario y refresca la lista cuando el envío comenzó mientras se editaba', async () => {
    let campaign = scheduled()
    routeFetchJson(() => Promise.resolve({ campaigns: [campaign], scheduler_enabled: true }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      campaign = scheduled({ status: 'running', started_at: '2035-10-02T20:30:00Z' })
      return jsonResponse({ error: 'La campaña ya empezó a enviarse' }, 409)
    }))
    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar horario de Promo Mayo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar horario' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ya empezó')
    expect(screen.getByLabelText('Hora de envío')).toHaveValue('17:30')
    expect(screen.queryByText(/Horario actualizado:/)).not.toBeInTheDocument()
    await screen.findByText('Enviando')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('button', { name: /Editar horario de/ })).not.toBeInTheDocument()
  })

  it.each<{ role: string; permissions: Record<string, string[]> }>([
    { role: 'viewer', permissions: {} },
    { role: 'operator', permissions: { campaigns: ['update'] } },
  ])('oculta la edición sin permisos de edición y envío: $role', async ({ role, permissions }) => {
    currentUser.value = { user: { role, id: 'owner' }, permissions }
    routeFetchJson(() => Promise.resolve({ campaigns: [scheduled()], scheduler_enabled: true }))
    render(<Page />); await screen.findByText('Promo Mayo')
    expect(screen.queryByRole('button', { name: /Editar horario de/ })).not.toBeInTheDocument()
  })

  it('permite al operador editar solo sus campañas pendientes y deshabilita la opción sin programador', async () => {
    currentUser.value = { user: { role: 'operator', id: 'owner' }, permissions: { campaigns: ['update'], send: ['send'] } }
    routeFetchJson(() => Promise.resolve({ campaigns: [
      scheduled(), scheduled({ id: 'other', name: 'Ajena', owned_by: 'other' }),
      scheduled({ id: 'started', name: 'Iniciada', started_at: '2035-10-02T20:30:00Z' }),
      scheduled({ id: 'locked', name: 'Bloqueada', processor_locked_at: '2035-10-02T20:30:00Z' }),
      scheduled({ id: 'done', name: 'Completada', status: 'completed' }),
    ], scheduler_enabled: false }))
    render(<Page />)
    expect(await screen.findByRole('button', { name: 'Editar horario de Promo Mayo' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /Editar horario de/ })).toHaveLength(1)
  })

  it('envía la fecha con offset explícito de Argentina cuando el scheduler está habilitado', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [], scheduler_enabled: true }))
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'nueva', status: 'scheduled' }))
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Programada' } })
    chooseAudience()
    fireEvent.change(screen.getByPlaceholderText(/tenemos una oferta especial/), { target: { value: 'Hola {{nombre}}' } })
    nextStep()
    expect(screen.getByText(/hora de Argentina \(America\/Argentina\/Buenos_Aires\)/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Programar envío/), { target: { value: '2026-10-01T09:30' } })

    nextStep()
    fireEvent.click(screen.getByRole('button', { name: /Programar campaña/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = postedBody(fetchMock)
    expect(body.scheduled_at).toBe('2026-10-01T09:30:00-03:00')
    expect(body).toMatchObject({ message_type: 'text', messages: ['Hola {{nombre}}'], message: 'Hola {{nombre}}' })
  })

  it('sin scheduler habilitado no permite programar pero sí guardar borrador', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [] }))
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'nueva', status: 'draft' }))
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))

    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: 'Borrador' } })
    chooseAudience()
    fireEvent.change(screen.getByPlaceholderText(/tenemos una oferta especial/), { target: { value: 'Hola' } })
    nextStep()
    expect(screen.getByLabelText(/Programar envío/)).toBeDisabled()
    expect(screen.getByText(/Programación automática no habilitada/)).toBeInTheDocument()
    nextStep()
    fireEvent.click(screen.getByRole('button', { name: /Guardar campaña/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(postedBody(fetchMock).scheduled_at).toBeNull()
  })
})

describe('Campañas — pausas y límites', () => {
  const LEGACY_FIELDS = ['anti_ban_profile_id', 'delay_type', 'custom_delay_seconds', 'daily_limit_override', 'enable_mini_sessions', 'mini_session_text']

  const openTextForm = async (name: string) => {
    render(<Page />)
    await screen.findByText('No hay campañas todavía')
    fireEvent.click(screen.getByRole('button', { name: /Nueva campaña/ }))
    fireEvent.change(screen.getByPlaceholderText(/Retención VIP Mayo/), { target: { value: name } })
    chooseAudience()
    fireEvent.change(screen.getByPlaceholderText(/tenemos una oferta especial/), { target: { value: 'Hola' } })
    nextStep()
  }

  it('persiste antiblock_delay_min/max sin campos legacy ni consulta de perfiles anti-ban', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [], scheduler_enabled: false }))
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'nueva', status: 'draft' }))
    vi.stubGlobal('fetch', fetchMock)

    await openTextForm('Pausas')
    expect(screen.getByText('Pausas y límites')).toBeInTheDocument()
    expect(screen.queryByText(/Perfil Anti-Ban/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Mini-sesión/)).not.toBeInTheDocument()
    expect(screen.getByText(/Reparto automático entre líneas activas/)).toBeInTheDocument()

    const min = screen.getByLabelText('Pausa mínima (segundos)')
    const max = screen.getByLabelText('Pausa máxima (segundos)')
    expect(min).toHaveAttribute('min', '3')
    expect(min).toHaveAttribute('max', '300')
    expect(max).toHaveAttribute('max', '300')
    fireEvent.change(min, { target: { value: '12' } })
    fireEvent.change(max, { target: { value: '45' } })
    nextStep()

    fireEvent.click(screen.getByRole('button', { name: /Guardar campaña/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = postedBody(fetchMock)
    expect(body).toMatchObject({ antiblock_delay_min: 12, antiblock_delay_max: 45 })
    for (const field of LEGACY_FIELDS) expect(body).not.toHaveProperty(field)

    const urls = [...vi.mocked(fetchJson).mock.calls.map(([u]) => String(u)), ...fetchMock.mock.calls.map(([u]) => String(u))]
    expect(urls.some(u => u.includes('/api/anti-ban-profiles'))).toBe(false)
  })

  it('bloquea el POST si la pausa mínima supera la máxima', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [], scheduler_enabled: false }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await openTextForm('Pausas inválidas')
    fireEvent.change(screen.getByLabelText('Pausa mínima (segundos)'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Pausa máxima (segundos)'), { target: { value: '10' } })
    nextStep()

    expect(await screen.findByRole('alert')).toHaveTextContent('La pausa mínima no puede ser mayor que la pausa máxima')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bloquea el POST si una pausa está fuera de 3–300 segundos', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [], scheduler_enabled: false }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await openTextForm('Pausa excesiva')
    fireEvent.change(screen.getByLabelText('Pausa máxima (segundos)'), { target: { value: '301' } })
    nextStep()

    expect(await screen.findByRole('alert')).toHaveTextContent('entre 3 y 300 segundos')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Campañas — reiniciar una cancelada sin envíos', () => {
  const cancelled = (over: Record<string, unknown> = {}) => makeCampaign({
    status: 'cancelled', owned_by: 'owner', list_id: 'l1', list_name: 'VIP', use_multi_line: true,
    ...over,
  })

  it('ofrece Reiniciar con todos los contadores en cero y no cambia nada si se rechaza la confirmación', async () => {
    routeFetchJson(() => Promise.resolve({ campaigns: [cancelled()], scheduler_enabled: true }))
    const fetchMock = vi.fn()
    const confirmMock = vi.fn().mockReturnValue(false)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', confirmMock)

    render(<Page />)
    const restart = await screen.findByRole('button', { name: 'Reiniciar' })
    expect(restart).toBeEnabled()
    expect(screen.getByText('Cancelado')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reanudar' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(restart)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('pausada'))
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Reanudar'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText('Cancelado')).toBeInTheDocument()
  })

  it('confirma sólo el reinicio y muestra Reanudar tras recargar, sin iniciar envíos automáticamente', async () => {
    let campaign = cancelled()
    routeFetchJson(() => Promise.resolve({ campaigns: [campaign], scheduler_enabled: true }))
    const confirmMock = vi.fn().mockReturnValue(true)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/campaigns/c-a/freq-reset')
      expect(init?.method).toBe('DELETE')
      campaign = cancelled({ status: 'paused', pause_reason: 'manual' })
      return jsonResponse({ ok: true, deleted_history: 0, reset_recipients: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', confirmMock)

    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reiniciar' }))

    expect(await screen.findByRole('button', { name: 'Reanudar' })).toBeEnabled()
    expect(screen.getByText('Pausado')).toBeInTheDocument()
    expect(screen.queryByText('Cancelado')).not.toBeInTheDocument()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/campaigns/c-a/freq-reset',
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm_reset: true }) },
    ])
    expect(fetchMock.mock.calls.some(([url]) => /\/(dispatch|send|retry-failed)$/.test(url))).toBe(false)
    expect(vi.mocked(fetchJson).mock.calls.filter(([url]) => String(url) === '/api/campaigns')).toHaveLength(2)
  })

  it.each([
    { role: 'viewer', status: 'cancelled', lock: null },
    { role: 'operator', status: 'cancelled', lock: null },
    { role: 'admin', status: 'cancelled', lock: '2026-10-08T23:00:00Z' },
    { role: 'admin', status: 'draft', lock: null },
    { role: 'admin', status: 'scheduled', lock: null },
    { role: 'admin', status: 'running', lock: null },
  ])('conserva las restricciones de rol y estado: $role / $status / lock=$lock', async ({ role, status, lock }) => {
    currentUser.value = { user: { role, id: 'owner' }, permissions: {} }
    routeFetchJson(() => Promise.resolve({
      campaigns: [cancelled({ status, processor_locked_at: lock })], scheduler_enabled: true,
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<Page />)
    await screen.findByText('Promo Mayo')
    expect(screen.queryByRole('button', { name: 'Reiniciar' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
