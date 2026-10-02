import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', async () => {
  const { createElement: h } = await import('react')
  return { default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => h('a', { href, ...rest }, children) }
})

import { CloudReadiness } from '@/components/campaigns/CloudReadiness'
import type { CloudLineReadiness, CloudReadinessResponse, ReadinessCheck } from '@/lib/cloud-api/campaign-readiness'

const ok = (key: ReadinessCheck['key'], label: string, detail = 'Correcto.'): ReadinessCheck => ({ key, status: 'ok', label, detail })

function line(over: Partial<CloudLineReadiness> = {}): CloudLineReadiness {
  return {
    line_id: 'line-1', line_name: 'Solbatt', verified_name: 'Solbatt SA', number_linked: true, cloud_number_id: 'cn-1',
    phone_number_id: '1001', waba_id: '1111',
    token_expires_at: '2026-12-01T12:00:00.000Z', token_expiry_state: 'valid', token_days_remaining: 65,
    last_webhook_at: '2026-10-01T02:30:00.000Z', approved_template_count: 2,
    checks: [
      ok('active', 'Línea y número activos'), ok('connected', 'Línea conectada'),
      ok('sending_enabled', 'Envíos habilitados'), ok('campaign_allowed', 'Uso para campañas'),
      ok('token_present', 'Token de acceso almacenado'),
      ok('token_expiry', 'Vencimiento del token', 'El token vence en 65 días.'),
      ok('approved_templates', 'Plantillas aprobadas sincronizadas'),
      { key: 'last_webhook', status: 'info', label: 'Última recepción de webhook', detail: 'Dato informativo.' },
    ],
    blocking_count: 0, warning_count: 0, summary: 'local_checks_complete',
    ...over,
  }
}
const payload = (lines: CloudLineReadiness[]): CloudReadinessResponse => ({
  checked_at: '2026-09-27T15:00:00.000Z', source: 'local_database', live_meta_check: false, lines,
})
// Valor mostrado junto al check (fecha en hora Argentina o conteo).
const valueOf = (scope: HTMLElement, key: ReadinessCheck['key']) =>
  scope.querySelector(`[data-check="${key}"] [data-value]`)?.textContent ?? null
const respond =(body: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response)
function deferred() {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>(r => { resolve = r })
  return { promise, resolve: (body: unknown) => resolve({ ok: true, status: 200, json: async () => body } as Response) }
}

let fetchMock: ReturnType<typeof vi.fn>
const button = () => screen.getByRole('button', { name: 'Revisar WhatsApp API' })
const click = async () => { await act(async () => { fireEvent.click(button()) }) }

beforeEach(() => {
  fetchMock = vi.fn(() => respond(payload([line()])))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('CloudReadiness — carga bajo demanda', () => {
  it('does not fetch on mount nor poll after a manual check', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<CloudReadiness />)
    await act(async () => { vi.advanceTimersByTime(120_000) })
    expect(fetchMock).not.toHaveBeenCalled()

    await click()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/campaigns/cloud-readiness', expect.objectContaining({ cache: 'no-store' }))
    await act(async () => { vi.advanceTimersByTime(120_000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('disables the button while loading and shows refreshed data on repeat', async () => {
    const first = deferred()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(respond(payload([line({ approved_template_count: 4 })])))
    render(<CloudReadiness />)
    await click()
    expect(button()).toBeDisabled()
    await act(async () => first.resolve(payload([line({ approved_template_count: 0 })])))
    expect(button()).not.toBeDisabled()
    expect(valueOf(document.body, 'approved_templates')).toBe('0')

    await click()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(valueOf(document.body, 'approved_templates')).toBe('4')
  })

  it('aborts the in-flight request on unmount and ignores its late response', async () => {
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise)
    const { unmount } = render(<CloudReadiness />)
    await click()
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => slow.resolve(payload([line({ line_name: 'Vieja' })])))
    expect(screen.queryByText('Vieja')).toBeNull()
  })
})

describe('CloudReadiness — estados', () => {
  it('shows a load error distinctly from "no Cloud lines"', async () => {
    fetchMock.mockReturnValueOnce(respond({ error: 'x' }, 500))
    render(<CloudReadiness />)
    await click()
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo obtener el diagnóstico local')
    expect(screen.queryByText(/No hay líneas WhatsApp Cloud API/)).toBeNull()
  })

  it('shows a network failure as an error, not as an empty list', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    render(<CloudReadiness />)
    await click()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/No hay líneas WhatsApp Cloud API/)).toBeNull()
  })

  it('shows a permission error for 403', async () => {
    fetchMock.mockReturnValueOnce(respond({ error: 'Forbidden' }, 403))
    render(<CloudReadiness />)
    await click()
    expect(screen.getByRole('alert')).toHaveTextContent('No tenés permiso')
  })

  it('shows the empty state without an alert when no Cloud lines are visible', async () => {
    fetchMock.mockReturnValueOnce(respond(payload([])))
    render(<CloudReadiness />)
    await click()
    expect(screen.getByText(/No hay líneas WhatsApp Cloud API visibles/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('can be collapsed without losing the result', async () => {
    render(<CloudReadiness />)
    await click()
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar' }))
    expect(screen.queryByText('Solbatt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar' }))
    expect(screen.getByText('Solbatt')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('CloudReadiness — contenido', () => {
  it('formats token expiry and last webhook in Argentina time', async () => {
    render(<CloudReadiness />)
    await click()
    const item = screen.getByRole('listitem', { name: 'Diagnóstico de Solbatt' })
    // 02:30 UTC del 1/10 corresponde a las 23:30 del 30/9 en Argentina.
    const webhook = valueOf(item, 'last_webhook')
    expect(webhook).toContain('30/9/2026')
    expect(webhook).toContain('23:30')
    expect(webhook).toContain('(hora Argentina)')
    expect(valueOf(item, 'token_expiry')).toContain('1/12/2026')
    expect(valueOf(item, 'approved_templates')).toBe('2')
    // Cada fecha aparece una sola vez (sin grilla duplicada).
    expect(item.textContent!.split('30/9/2026').length - 1).toBe(1)
  })

  it('uses the natural heading', () => {
    render(<CloudReadiness />)
    expect(screen.getByRole('heading', { name: 'Estado de WhatsApp API' })).toBeInTheDocument()
  })

  it('shows a Cloud line without a linked number and a line that does not admit campaigns', async () => {
    fetchMock.mockReturnValueOnce(respond(payload([
      line({
        line_id: 'line-pending', line_name: 'Pendiente', verified_name: null, number_linked: false,
        cloud_number_id: null, phone_number_id: null, waba_id: null, token_expires_at: null,
        token_expiry_state: 'unknown', last_webhook_at: null, approved_template_count: 0,
        summary: 'blocked', blocking_count: 1, warning_count: 0,
        checks: [{ key: 'active', status: 'blocking', label: 'Línea y número activos', detail: 'La línea no tiene un número Cloud vinculado.' }],
      }),
      line({
        line_id: 'line-3', cloud_number_id: 'cn-3', line_name: 'Chatbot', summary: 'blocked', blocking_count: 1,
        checks: [{ key: 'campaign_allowed', status: 'blocking', label: 'Uso para campañas', detail: 'La línea no admite campañas; sólo está habilitada para otros usos.' }],
      }),
    ])))
    render(<CloudReadiness />)
    await click()
    const pending = screen.getByRole('listitem', { name: 'Diagnóstico de Pendiente' })
    expect(within(pending).getByText(/no tiene un número Cloud vinculado/)).toBeInTheDocument()
    expect(pending.textContent).not.toMatch(/null|undefined/)
    const chatbot = screen.getByRole('listitem', { name: 'Diagnóstico de Chatbot' })
    expect(within(chatbot).getByText(/La línea no admite campañas/)).toBeInTheDocument()
    expect(within(chatbot).getByText('Con bloqueos')).toBeInTheDocument()
  })

  it('shows blocking issues and unknown dates without claiming readiness', async () => {
    fetchMock.mockReturnValueOnce(respond(payload([
      line({
        token_expires_at: '2026-09-20T12:00:00.000Z', token_expiry_state: 'expired', approved_template_count: 0,
        summary: 'blocked', blocking_count: 2, warning_count: 0,
        checks: [
          { key: 'token_expiry', status: 'blocking', label: 'Vencimiento del token', detail: 'El token está vencido.' },
          { key: 'approved_templates', status: 'blocking', label: 'Plantillas aprobadas sincronizadas', detail: 'Las campañas con plantilla no pueden enviarse.' },
        ],
      }),
      line({
        line_id: 'line-2', cloud_number_id: 'cn-2', line_name: 'Otra', verified_name: null,
        token_expires_at: null, token_expiry_state: 'unknown', last_webhook_at: null,
        summary: 'warnings', blocking_count: 0, warning_count: 1,
        checks: [
          { key: 'token_expiry', status: 'warning', label: 'Vencimiento del token', detail: 'No hay fecha de vencimiento registrada.' },
          { key: 'last_webhook', status: 'info', label: 'Última recepción de webhook', detail: 'Dato informativo.' },
        ],
      }),
    ])))
    render(<CloudReadiness />)
    await click()
    const expired = screen.getByRole('listitem', { name: 'Diagnóstico de Solbatt' })
    expect(within(expired).getByText('Con bloqueos')).toBeInTheDocument()
    expect(within(expired).getByText(/El token está vencido/)).toBeInTheDocument()
    expect(valueOf(expired, 'token_expiry')).toContain('20/9/2026')
    const unknown = screen.getByRole('listitem', { name: 'Diagnóstico de Otra' })
    expect(within(unknown).getByText('Con advertencias')).toBeInTheDocument()
    expect(valueOf(unknown, 'token_expiry')).toBe('Fecha desconocida')
    expect(valueOf(unknown, 'last_webhook')).toBe('Sin registro')
    expect(screen.queryByText('Comprobaciones locales completas')).toBeNull()
    expect(document.body.textContent).not.toMatch(/list[oa] para|garantiz/i)
  })

  it('describes a clean result only as local checks, with the scope notice and internal links', async () => {
    render(<CloudReadiness />)
    await click()
    expect(screen.getByText('Comprobaciones locales completas')).toBeInTheDocument()
    expect(screen.getByText(/no consulta Meta en vivo ni autoriza envíos/)).toBeInTheDocument()
    expect(screen.getByText(/se actualiza desde Nueva campaña/)).toBeInTheDocument()
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'))
    expect(new Set(hrefs)).toEqual(new Set(['/lines', '/lines/cloud-onboard', '/lines/cloud-inbox']))
    expect(document.body.textContent).not.toMatch(/list[oa] para|garantiz/i)
  })
})
