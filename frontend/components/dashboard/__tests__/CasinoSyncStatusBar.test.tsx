/**
 * CasinoSyncStatusBar — fase 4, lee GET /api/dashboard/casino/sync-status
 * y pinta un badge compacto por plataforma (running/ok/failed/never_synced),
 * sin ocultar fallos ni requerir login inventado.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CasinoSyncStatusBar } from '../CasinoSyncStatusBar'

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
}

describe('CasinoSyncStatusBar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders a badge per platform reflecting the real status (never hides a failure)', async () => {
    global.fetch = mockFetchOnce({
      platforms: {
        zeus: { platformRun: { status: 'ok' }, agents: [{ agente: 'betcoin', status: 'ok', lastSuccessfulAt: '2026-09-20T10:00:00.000Z' }], lastSkipAt: null },
        bet30: { platformRun: null, agents: [{ agente: 'btcuno', status: 'failed', error: 'HTTP 401', lastSuccessfulAt: null }], lastSkipAt: null },
        ganamos: { platformRun: null, agents: [{ agente: 'adminroyal', status: 'never_synced', lastSuccessfulAt: null }], lastSkipAt: null },
        argenbet: { platformRun: { status: 'running' }, agents: [{ agente: 'adminbtc', status: 'ok', lastSuccessfulAt: '2026-09-20T10:00:00.000Z' }], lastSkipAt: null },
      },
    })

    render(<CasinoSyncStatusBar />)

    await waitFor(() => expect(screen.getByText('zeus')).toBeInTheDocument())
    expect(screen.getByText('bet30')).toBeInTheDocument()
    expect(screen.getByText(/1 agente con error/)).toBeInTheDocument() // bet30's failed agent surfaced, not hidden
    expect(screen.getByText('Sincronizando')).toBeInTheDocument() // argenbet's platform-level run in progress
    expect(screen.getByText('Error')).toBeInTheDocument() // bet30
    expect(screen.getByText('Sin historial')).toBeInTheDocument() // ganamos, never synced — not silently omitted
  })

  it('regression: a failed platform-level run (config/auth preflight) stays red even when all agents still show a stale ok status', async () => {
    // A config/credential failure never got far enough to touch any agent, so
    // agents keep whatever status they had from their last real run (ok).
    // The platform-level run is what must win here — otherwise a config
    // failure would render as a false "Correcto".
    global.fetch = mockFetchOnce({
      platforms: {
        zeus: {
          platformRun: { status: 'failed', error: 'Configurar ZEUS_API_KEY + ZEUS_PLAYER_TOKEN en el servidor' },
          agents: [{ agente: 'betcoin', status: 'ok', lastSuccessfulAt: '2026-09-18T10:00:00.000Z' }],
          lastSkipAt: null,
        },
        bet30:    { platformRun: null, agents: [{ agente: 'btcuno', status: 'ok', lastSuccessfulAt: '2026-09-20T10:00:00.000Z' }], lastSkipAt: null },
        ganamos:  { platformRun: null, agents: [{ agente: 'adminroyal', status: 'ok', lastSuccessfulAt: '2026-09-20T10:00:00.000Z' }], lastSkipAt: null },
        argenbet: { platformRun: null, agents: [{ agente: 'adminbtc', status: 'ok', lastSuccessfulAt: '2026-09-20T10:00:00.000Z' }], lastSkipAt: null },
      },
    })

    render(<CasinoSyncStatusBar />)

    await waitFor(() => expect(screen.getByText('zeus')).toBeInTheDocument())
    // zeus must render as failed ("Error"), never "Correcto", despite its only agent being ok
    const zeusRow = screen.getByText('zeus').closest('div')
    expect(zeusRow).not.toBeNull()
    expect(zeusRow!.textContent).toContain('Error')
    expect(zeusRow!.textContent).not.toContain('Correcto')
  })

  it('does not claim success when some configured agents have never synchronized', async () => {
    global.fetch = mockFetchOnce({ platforms: { zeus: {
      platformRun: { status: 'ok' },
      agents: [{ agente: 'betcoin', status: 'ok' }, { agente: 'bigwin', status: 'never_synced' }],
    } } })
    render(<CasinoSyncStatusBar />)
    await waitFor(() => expect(screen.getByText('Hay agentes sin sincronizar')).toBeInTheDocument())
    expect(screen.getByText('zeus').closest('div')!.textContent).not.toContain('Correcto')
  })

  it('shows a visible error banner (not a blank/silent widget) when the endpoint itself fails', async () => {
    global.fetch = mockFetchOnce({ error: 'casino_sync_runs no existe' }, false, 503)

    render(<CasinoSyncStatusBar />)

    await waitFor(() => expect(screen.getByText(/casino_sync_runs no existe/)).toBeInTheDocument())
  })
})
