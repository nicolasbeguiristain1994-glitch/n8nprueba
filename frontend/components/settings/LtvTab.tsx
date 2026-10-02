'use client'
import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, AlertCircle, CheckCircle2, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchJson } from '@/lib/fetchJson'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface DistributionRow {
  agente:  string | null
  tierLtv: string
  total:   number
}

interface RecomputeResult {
  rowsProcessed: number
  durationMs:    number
  calculatedAt:  string
  triggeredBy:   string
}

// ── Constantes de UI ──────────────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
  super_vip: 'Super Vip',
  vip_alto:  'Vip Alto',
  vip_medio: 'Vip Medio',
  vip:       'Vip',
  medio:     'Medio',
  bajo:      'Bajo',
}

const TIER_STYLE: Record<string, string> = {
  super_vip: 'bg-purple-100 text-purple-700',
  vip_alto:  'bg-warning/15 text-warning',
  vip_medio: 'bg-warning/10 text-amber-600',
  vip:       'bg-yellow-100 text-yellow-700',
  medio:     'bg-blue-100 text-blue-700',
  bajo:      'bg-muted text-muted-foreground',
}

const TIER_ORDER = ['super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo']

const SCORE_MAP: Record<string, number> = {
  super_vip: 60,
  vip_alto:  52,
  vip_medio: 45,
  vip:       40,
  medio:     25,
  bajo:      10,
}

const PERCENTIL_MAP: Record<string, string> = {
  super_vip: '≥ P90',
  vip_alto:  'P75–P89',
  vip_medio: 'P60–P74',
  vip:       'P40–P59',
  medio:     'P20–P39',
  bajo:      '< P20',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByAgente(rows: DistributionRow[]): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    const agent = row.agente ?? 'sin_agente'
    if (!result[agent]) result[agent] = {}
    result[agent][row.tierLtv] = row.total
  }
  return result
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Componente ────────────────────────────────────────────────────────────────

export function LtvTab({ isAdmin }: { isAdmin: boolean }) {
  const [distribution, setDistribution] = useState<DistributionRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null)
  const [loading, setLoading]             = useState(true)
  const [recomputing, setRecomputing]     = useState(false)
  const [msg, setMsg]                     = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [distResult, tsResult] = await Promise.all([
        fetchJson<{ data: DistributionRow[] }>('/api/contacts/ltv/distribution'),
        fetchJson<{ lastSuccessAt: string | null }>('/api/contacts/ltv/last-success'),
      ])
      setDistribution(distResult.data)
      setLastSuccessAt(tsResult.lastSuccessAt)
    } catch {
      setDistribution(null)
      setLoadError('No se pudo cargar LTV. Reintentá; si el error continúa, revisá la instalación del módulo.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleRecompute = async () => {
    setRecomputing(true)
    setMsg(null)
    try {
      const res = await fetchJson<RecomputeResult>('/api/contacts/recompute-ltv', { method: 'POST' })
      setMsg({
        type: 'ok',
        text: `LTV recalculado: ${res.rowsProcessed.toLocaleString()} jugadores en ${(res.durationMs / 1000).toFixed(1)}s`,
      })
      await load()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Error al recalcular' })
    } finally {
      setRecomputing(false)
    }
  }

  const grouped = distribution ? groupByAgente(distribution) : {}
  const agents  = Object.keys(grouped).sort()

  return (
    <div className="space-y-6">

      {/* Header con botón de recompute */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <TrendingUp size={16} className="text-success" />
            LTV (Lifetime Value)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Score dinámico 0–60 basado en percentil de NGR por plataforma y agente. Reemplaza el value_score plano en el recompute de prioridades.
          </p>
          {lastSuccessAt && (
            <p className="text-xs text-muted-foreground mt-1">
              Último cálculo: {formatDate(lastSuccessAt)}
            </p>
          )}
        </div>
        {isAdmin && (
          <Button
            onClick={handleRecompute}
            disabled={recomputing || loading || Boolean(loadError)}
            size="sm"
            variant="outline"
            className="gap-2 shrink-0"
          >
            <RefreshCw size={13} className={recomputing ? 'animate-spin' : ''} />
            {recomputing ? 'Calculando…' : 'Recalcular LTV'}
          </Button>
        )}
      </div>

      {/* Mensaje de resultado */}
      {msg && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
          msg.type === 'ok' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
        }`}>
          {msg.type === 'ok'
            ? <CheckCircle2 size={14} />
            : <AlertCircle size={14} />
          }
          {msg.text}
        </div>
      )}

      {/* Referencia de tiers */}
      <div className="bg-background rounded-lg p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Mapeo de percentil → LTV Score</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {TIER_ORDER.map(tier => (
            <div key={tier} className="text-center">
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${TIER_STYLE[tier]}`}>
                {TIER_LABEL[tier]}
              </span>
              <p className="text-xs text-muted-foreground mt-1">{PERCENTIL_MAP[tier]}</p>
              <p className="text-xs font-semibold text-foreground">{SCORE_MAP[tier]} pts</p>
            </div>
          ))}
        </div>
      </div>

      {/* Distribución por agente */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          <RefreshCw size={15} className="animate-spin mr-2" /> Cargando distribución…
        </div>
      ) : loadError ? (
        <div role="alert" className="text-center py-8 text-sm text-destructive">
          <p>{loadError}</p>
          <Button variant="outline" className="mt-3" onClick={load}>Reintentar</Button>
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          Sin datos de LTV — ejecutá el recálculo para poblar la tabla.
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Distribución por agente</p>
          {agents.map(agent => {
            const tiers = grouped[agent]
            const total = Object.values(tiers).reduce((a, b) => a + b, 0)
            return (
              <div key={agent} className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-background border-b border-border flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground capitalize">{agent}</span>
                  <span className="text-xs text-muted-foreground">{total.toLocaleString()} jugadores</span>
                </div>
                <div className="px-4 py-3 flex flex-wrap gap-3">
                  {TIER_ORDER.map(tier => {
                    const count = tiers[tier] ?? 0
                    if (count === 0) return null
                    const pct   = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0'
                    return (
                      <div key={tier} className="flex items-center gap-1.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TIER_STYLE[tier]}`}>
                          {TIER_LABEL[tier]}
                        </span>
                        <span className="text-sm font-semibold text-foreground tabular-nums">
                          {count.toLocaleString()}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">({pct}%)</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
