import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineVolumeRecommendation as Recommendation } from '@/lib/line-volume-policy'
import { LineVolumeRecommendation } from '../LineVolumeRecommendation'
import LinesPage from '@/app/(protected)/lines/page'

const identity = vi.hoisted(() => ({ user: { role: 'operator', id: 'operator' }, permissions: {} as Record<string, string[]> }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => identity }))
vi.mock('@/components/lines/LineProfilePhoto', () => ({ LineProfilePhoto: () => null }))

const recommendation = (over: Partial<Recommendation> = {}): Recommendation => ({
  status: 'hold', suggestedToday: 50, attemptedToday: 20, acceptedToday: 19, remainingToday: 30, availableNow: 10,
  nextHealthyDay: 75, stage: 2, qualifyingDays: 1, requiredDays: 3,
  reason: 'Mantener el volumen mientras se reúnen resultados suficientes.', reasons: [],
  evaluatedAt: '2026-10-19T15:00:00Z', date: '2026-10-19', timeZone: 'America/Argentina/Buenos_Aires',
  quality: 'GREEN', deliveryRate: 0.95, failureRate: 0.05, optOuts: 0, sampleSize: 40,
  lastMetaCheckAt: '2026-10-19T14:59:00Z', dailyLimit: 500, policyVersion: 'test',
  recentDays: [{ date: '2026-10-18', attempted: 40, accepted: 39, delivered: 38, failed: 2, ecosystemRejected: 0, optOuts: 0, lastSentAt: '2026-10-18T15:00:00Z' }],
  ...over,
})
const line = { id: 'line-one', line_key: 'line-one', display_name: 'Línea de prueba', phone_number: '+15555550123',
  evolution_instance: 'test', status: 'active', is_connected: true, sending_enabled: true, eligible: true, line_type: 'cloud',
  msgs_sent_today: 123, msgs_sent_hour: 4, msg_per_day: 500, msg_per_hour: 20, total_sent: 456, total_failed: 2,
  priority: 1, last_seen_at: '2026-10-19T15:00:00Z', cloud_phone_number_id: '12345', cloud_waba_id: 'waba',
  owner_user_id: 'owner', respect_daily_recommendation: false, cloud_quality_rating: 'GREEN', cloud_messaging_limit_tier: 'TIER_1K', cloud_coexistence_enabled: false,
  chatwoot_inbox_id: null, chatwoot_inbox_name: null, cloud_status: 'active' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const fetcher = vi.fn()
const recommendationCalls = () => fetcher.mock.calls.filter(([url]) => url === '/api/lines/recommendations')
const noWrites = () => {
  for (const [url, options] of fetcher.mock.calls) {
    expect((options as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
    expect(String(url)).not.toContain('/warmup')
    expect(String(url)).not.toContain('/messages')
  }
}

beforeEach(() => {
  identity.user = { role: 'operator', id: 'operator' }; identity.permissions = {}
  fetcher.mockReset().mockImplementation(async (url: string) => url === '/api/lines'
    ? json({ lines: [line], metaConfigured: false }) : json({ recommendations: { [line.id]: recommendation() } }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('daily volume recommendation presentation', () => {
  it('does not turn a missing recommendation into a zero allowance', () => {
    render(<LineVolumeRecommendation lineName="Línea de prueba" compact />)
    expect(screen.getByText('Sin recomendación')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText(/0 sugeridos/)).not.toBeInTheDocument()
  })
  it('shows a stop without a misleading progress bar or promised next-day increase', () => {
    render(<LineVolumeRecommendation lineName="Línea de prueba" recommendation={recommendation({
      status: 'stop', suggestedToday: 0, remainingToday: 0, availableNow: 0, nextHealthyDay: null,
      reason: 'La cuenta tiene una restricción activa.',
    })} />)
    expect(screen.getByText('Detener')).toBeInTheDocument()
    expect(screen.getByText('La cuenta tiene una restricción activa.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText(/Próximo escalón posible/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('explains conditional growth using observed days instead of promising an increase tomorrow', () => {
    render(<LineVolumeRecommendation lineName="Línea de prueba" recommendation={recommendation()} />)
    expect(screen.getByText('1 de 3 días')).toBeInTheDocument()
    expect(screen.getByText(/Próximo escalón posible/)).toHaveTextContent('75 mensajes por día, si se cumplen las condiciones.')
    expect(screen.getByText(/El paso del tiempo por sí solo/)).toBeInTheDocument()
    expect(screen.getByText(/Los mensajes registrados incluyen fallos/)).toBeInTheDocument()
    expect(screen.getByText('Muestra de días cerrados (últimos 7 días)')).toBeInTheDocument()
    expect(screen.getByText(/Entrega y fallos usan días cerrados/)).toHaveTextContent('Las bajas incluyen hoy.')
    expect(screen.queryByText(/mañana|sin restricciones/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('caps visual progress without hiding messages already registered beyond the suggestion', () => {
    render(<LineVolumeRecommendation lineName="Línea de prueba" compact recommendation={recommendation({ attemptedToday: 70, remainingToday: 0 })} />)
    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuenow', '100')
    expect(progress).toHaveAttribute('aria-valuetext', '70 registrados de 50 sugeridos')
    expect(screen.getByText(/restantes/)).toHaveTextContent('50 sugeridos hoy · 0 restantes')
  })
  it('keeps unknown delivery measurements explicit in the supporting evidence', () => {
    render(<LineVolumeRecommendation lineName="Línea de prueba" recommendation={recommendation({ deliveryRate: null, failureRate: null, quality: null, lastMetaCheckAt: null })} />)
    expect(screen.getAllByText('Sin datos')).toHaveLength(3)
    expect(screen.getByText('Último control de Meta: Sin datos')).toBeInTheDocument()
    expect(screen.getByText(/19\/10\/2026 · America\/Argentina/)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Actividad diaria registrada de Línea de prueba' })).toHaveTextContent('18/10/2026')
  })
})

describe('recommendations inside Lines', () => {
  it('loads the line independently and opens supporting evidence without editing or sending', async () => {
    let resolve!: (value: Response) => void
    fetcher.mockImplementation(async (url: string) => url === '/api/lines' ? json({ lines: [line] })
      : new Promise<Response>(done => { resolve = done }))
    render(<LinesPage />)
    expect(await screen.findByText('Línea de prueba')).toBeInTheDocument()
    expect(screen.getByText('Consultando recomendación…')).toBeInTheDocument()
    await act(async () => { resolve(json({ recommendations: { [line.id]: recommendation() } })) })
    fireEvent.click(screen.getByRole('button', { name: 'Ver recomendación de Línea de prueba' }))
    const detail = screen.getByRole('dialog')
    const guidance = within(detail).getByRole('region', { name: 'Recomendación de Línea de prueba' })
    expect(within(guidance).getByText('Mensajes registrados hoy').nextElementSibling).toHaveTextContent('20')
    expect(within(guidance).getByText('Aceptados por WhatsApp hoy').nextElementSibling).toHaveTextContent('19')
    expect(within(detail).getByText('Calidad alta')).toBeInTheDocument()
    expect(within(detail).queryByText(/sin restricciones|Tier de envíos|1K \/ día/)).not.toBeInTheDocument()
    expect(within(detail).getByText(/El cupo vigente puede ser compartido/)).toBeInTheDocument()
    noWrites()
  })
  it('focuses the detail title on opening instead of scrolling to the history disclosure', async () => {
    render(<LinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver recomendación de Línea de prueba' }))
    const detail = screen.getByRole('dialog')
    const title = within(detail).getByRole('heading', { name: /Línea de prueba/ })
    await waitFor(() => expect(title).toHaveFocus())
    expect(title).toHaveAttribute('tabindex', '-1')
    expect(detail.querySelector('summary')).not.toHaveFocus()
    noWrites()
  })
  it.each(['UNKNOWN', 'NA', null])('shows unrated Meta quality %s neutrally in the table and detail', async (quality) => {
    fetcher.mockImplementation(async (url: string) => url === '/api/lines'
      ? json({ lines: [{ ...line, cloud_quality_rating: quality }] })
      : json({ recommendations: { [line.id]: recommendation({ quality }) } }))
    render(<LinesPage />)
    const badge = await screen.findByText('Sin evaluar')
    expect(badge).toHaveClass('text-muted-foreground')
    expect(badge).not.toHaveClass('text-destructive')
    expect(screen.queryByText('Calidad baja')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Ver recomendación de Línea de prueba' }))
    expect(within(screen.getByRole('dialog')).getByText('Sin evaluar')).toHaveClass('text-muted-foreground')
    expect(within(screen.getByRole('dialog')).queryByText('Calidad baja')).not.toBeInTheDocument()
    noWrites()
  })
  it('keeps lines usable when the recommendation endpoint fails and hides internal errors', async () => {
    fetcher.mockImplementation(async (url: string) => url === '/api/lines' ? json({ lines: [line] }) : json({ error: 'private SQL information' }, 500))
    render(<LinesPage />)
    expect(await screen.findByText('Sin recomendación')).toBeInTheDocument()
    expect(screen.getByText('Línea de prueba')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No se pudieron actualizar las recomendaciones')
    expect(screen.queryByText(/private SQL/)).not.toBeInTheDocument()
    expect(screen.queryByText(/0 sugeridos/)).not.toBeInTheDocument()
    noWrites()
  })
  it('ignores an older response when a refresh has already returned a newer recommendation', async () => {
    let oldResponse!: (value: Response) => void, oldSignal: AbortSignal | undefined
    let count = 0
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/lines') return json({ lines: [line] })
      if (++count === 1) { oldSignal = options?.signal as AbortSignal; return new Promise<Response>(resolve => { oldResponse = resolve }) }
      return json({ recommendations: { [line.id]: recommendation({ status: 'reduce', suggestedToday: 25, remainingToday: 5 }) } })
    })
    render(<LinesPage />)
    await screen.findByText('Línea de prueba')
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar líneas' }))
    expect(await screen.findByText('Bajar')).toBeInTheDocument()
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { oldResponse(json({ recommendations: { [line.id]: recommendation({ status: 'increase' }) } })) })
    expect(screen.getByText('Bajar')).toBeInTheDocument()
    expect(screen.queryByText('Subir')).not.toBeInTheDocument()
    noWrites()
  })
  it('refreshes visible recommendations and stops polling while hidden or unmounted', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { unmount } = render(<LinesPage />)
    await act(async () => {})
    expect(recommendationCalls()).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(recommendationCalls()).toHaveLength(2)
    hidden.mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(recommendationCalls()).toHaveLength(2)
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {})
    expect(recommendationCalls()).toHaveLength(3)
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(recommendationCalls()).toHaveLength(3)
    noWrites()
  })
  it('only renders recommendations attached to lines actually returned by the lines endpoint', async () => {
    fetcher.mockImplementation(async (url: string) => url === '/api/lines' ? json({ lines: [line] })
      : json({ recommendations: { [line.id]: recommendation(), inaccessible: recommendation({ status: 'stop', reason: 'Hidden line reason' }) } }))
    render(<LinesPage />)
    expect(await screen.findByText('Mantener')).toBeInTheDocument()
    expect(screen.queryByText('Detener')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden line reason')).not.toBeInTheDocument()
    noWrites()
  })
})


describe('automatic daily recommendation control', () => {
  it.each([false, true])('only persists an explicit save when changing the existing %s setting', async enabled => {
    identity.user = { role: 'admin', id: 'admin' }
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'PATCH'
      ? json({ ok: true }) : url === '/api/lines' ? json({ lines: [{ ...line, respect_daily_recommendation: enabled }] })
        : json({ recommendations: { [line.id]: recommendation() } }))
    render(<LinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Línea de prueba' }))
    const checkbox = screen.getByRole('checkbox', { name: 'Respetar automáticamente la recomendación diaria' })
    expect(checkbox).toHaveProperty('checked', enabled)
    fireEvent.click(checkbox)
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1))
    const body = JSON.parse(fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH')![1].body)
    expect(body.respect_daily_recommendation).toBe(!enabled)
    expect(body).not.toHaveProperty('sending_enabled')
  })
  it('allows an operator with update permission to configure only their own line', async () => {
    identity.user = { role: 'operator', id: 'owner' }; identity.permissions = { lines: ['read', 'update'] }
    fetcher.mockImplementation(async (url: string) => url === '/api/lines' ? json({ lines: [line, { ...line, id: 'shared', display_name: 'Línea compartida', owner_user_id: 'someone-else' }] })
      : json({ recommendations: { [line.id]: recommendation() } }))
    render(<LinesPage />)
    expect(await screen.findByRole('button', { name: 'Línea de prueba' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Línea compartida' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Línea de prueba' }))
    expect(screen.getByRole('checkbox', { name: 'Respetar automáticamente la recomendación diaria' })).not.toBeChecked()
    noWrites()
  })
  it('does not offer a control to viewers or operators without update permission', async () => {
    identity.user = { role: 'viewer', id: 'owner' }; identity.permissions = { lines: ['read'] }
    render(<LinesPage />)
    await screen.findByText('Línea de prueba')
    expect(screen.queryByRole('button', { name: 'Línea de prueba' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Ver recomendación de Línea de prueba' }))
    expect(screen.queryByRole('button', { name: 'Configurar control diario' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    noWrites()
  })
  it('preserves the draft and persisted state after the server refuses the change', async () => {
    identity.user = { role: 'admin', id: 'admin' }
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => options?.method === 'PATCH'
      ? json({ error: 'No tenés permiso para actualizar esta línea' }, 403)
      : url === '/api/lines' ? json({ lines: [line] }) : json({ recommendations: { [line.id]: recommendation() } }))
    render(<LinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Línea de prueba' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Respetar automáticamente la recomendación diaria' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByText('No tenés permiso para actualizar esta línea')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByText('Control automático: desactivado')).toBeInTheDocument()
  })
  it('keeps an enabled control visible when no fresh recommendation can be loaded', () => {
    render(<LineVolumeRecommendation lineName="Línea de prueba" respectDailyRecommendation />)
    expect(screen.getByText(/Control diario automático activo. Si falta una evaluación vigente/)).toBeInTheDocument()
    expect(screen.queryByText(/0 sugeridos|mañana/)).not.toBeInTheDocument()
  })
})
