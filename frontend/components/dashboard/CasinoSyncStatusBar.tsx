'use client'

import { useEffect, useState, useCallback } from 'react'
import { SYNC_PLATFORMS, type SyncPlatform } from '@/lib/casino-agents'

/**
 * Fase 4 (D4, "casino_sync_runs para que un sync caído sea visible /
 * exponé el último estado en el dashboard"): barra compacta de solo lectura
 * que consume GET /api/dashboard/casino/sync-status. No es un rediseño del
 * dashboard — un renglón con 4 badges (uno por plataforma) y un resumen de
 * agentes con error, con refresh propio cada 60s (independiente del
 * auto-refresh general del resto del dashboard, que consulta datos de
 * negocio, no estado de sync).
 */

interface AgentStatus {
  agente:           string
  status:           string
  startedAt:        string | null
  finishedAt:       string | null
  txInserted:       number | null
  error:            string | null
  lastSuccessfulAt: string | null
}

interface PlatformStatus {
  platformRun: { status: string; startedAt: string | null; finishedAt: string | null; error?: string | null } | null
  agents:      AgentStatus[]
  lastSkipAt:  string | null
}

type SyncStatusResponse = { platforms: Record<SyncPlatform, PlatformStatus> } | null

const REFRESH_MS = 60_000

const DOT_CLASS: Record<string, string> = {
  ok:            'bg-emerald-500',
  running:       'bg-amber-500 animate-pulse',
  failed:        'bg-destructive',
  partial:       'bg-amber-500',
  never_synced:  'bg-muted-foreground/40',
}

function statusLabel(platformRun: PlatformStatus['platformRun'], agents: AgentStatus[]) {
  if (platformRun?.status === 'running') return 'running'
  if (platformRun?.status === 'failed') return 'failed'
  const failedCount = agents.filter((a) => a.status === 'failed').length
  if (failedCount > 0) return 'failed'
  if (agents.every((a) => a.status === 'never_synced')) return 'never_synced'
  if (agents.some((a) => a.status === 'never_synced')) return 'partial'
  return 'ok'
}

const STATUS_TEXT: Record<string, string> = {
  ok: 'Correcto', running: 'Sincronizando', failed: 'Error', never_synced: 'Sin historial', partial: 'Hay agentes sin sincronizar',
}

export function CasinoSyncStatusBar() {
  const [data, setData]   = useState<SyncStatusResponse>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/casino/sync-status')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? `Error ${res.status} al leer el estado de sync`)
        return
      }
      setData(await res.json())
      setError(null)
    } catch {
      setError('Error de red al leer el estado de sync')
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  if (error) {
    return (
      <div className="mb-3 px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-xs flex items-center gap-2">
        <span>⚠</span>
        <span>Estado de sync no disponible: {error}</span>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="mb-3 px-3 py-2 rounded-lg border border-border/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {SYNC_PLATFORMS.map((platform) => {
        const platformData = data.platforms[platform]
        const label = statusLabel(platformData?.platformRun ?? null, platformData?.agents ?? [])
        const failedAgents = (platformData?.agents ?? []).filter((a) => a.status === 'failed')
        const lastSuccess = (platformData?.agents ?? []).map((a) => a.lastSuccessfulAt).filter((value): value is string => !!value).sort().at(-1)
        const details = [platformData?.platformRun?.error, ...failedAgents.map((a) => `${a.agente}: ${a.error}`)].filter(Boolean).join('\n')
        return (
          <div key={platform} className="flex flex-wrap items-center gap-1.5" title={details}>
            <span className={`inline-block h-2 w-2 rounded-full ${DOT_CLASS[label] ?? DOT_CLASS.never_synced}`} />
            <span className="font-medium text-foreground">{platform}</span>
            <span>{STATUS_TEXT[label] ?? label}</span>
            {lastSuccess && <span>Último éxito de un agente: {new Date(lastSuccess).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</span>}
            {failedAgents.length > 0 && <span className="text-destructive">({failedAgents.length} agente{failedAgents.length > 1 ? 's' : ''} con error)</span>}
          </div>
        )
      })}
    </div>
  )
}
