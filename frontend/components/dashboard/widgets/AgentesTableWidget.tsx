'use client'

import { memo, useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Users, GitCompare, X, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Platform } from '@/lib/casino-agents'
import type { CasinoAgente } from '@/app/api/dashboard/casino/route'

// ── Period ─────────────────────────────────────────────────────────────────────

export type Period = 'mes_actual' | 'mes_anterior' | 'custom'

const PERIOD_LABELS: Record<Period, string> = {
  mes_actual:   'Mes Actual',
  mes_anterior: 'Mes Anterior',
  custom:       'Rango personalizado',
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function toISO(d: Date): string { return d.toISOString().split('T')[0] }

function mesActualFrom(): string {
  const d = new Date()
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1))
}
function mesAnteriorFrom(): string {
  const d = new Date()
  const last = new Date(d.getFullYear(), d.getMonth(), 0)
  return toISO(new Date(last.getFullYear(), last.getMonth(), 1))
}
function mesAnteriorTo(): string {
  const d = new Date()
  return toISO(new Date(d.getFullYear(), d.getMonth(), 0))
}

function resolveRange(period: Period, from: string, to: string): { from: string; to: string } {
  const now = new Date()
  switch (period) {
    case 'mes_actual':   return { from: mesActualFrom(), to: toISO(now) }
    case 'mes_anterior': return { from: mesAnteriorFrom(), to: mesAnteriorTo() }
    case 'custom':       return { from, to }
  }
}

function periodDisplayLabel(period: Period, from: string, to: string): string {
  if (period !== 'custom') return PERIOD_LABELS[period]
  return `${from} → ${to}`
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtNum(n: number): string { return n.toLocaleString('es-AR') }

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`
  return `$${n.toLocaleString('es-AR')}`
}

function fmtPct(n: number): string { return `${n.toFixed(1)}%` }

// ── Metrics catalogue ──────────────────────────────────────────────────────────

type AggKey = 'total' | 'nuevos_mes' | 'activos_mes' | 'vip' | 'en_riesgo' | 'sum_cargas' | 'sum_retiros' | 'avg_cargas' | 'response_rate' | 'reload_rate'

interface MetricDef {
  key:            AggKey
  label:          string
  fmtFn:          (n: number) => string
  /** Whether a higher value means better performance (affects diff coloring) */
  higherIsBetter: boolean
}

const METRICS: MetricDef[] = [
  { key: 'total',         label: 'Total',        fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'nuevos_mes',    label: 'Nuevos',       fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'activos_mes',   label: 'Activos',      fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'vip',           label: 'VIP',          fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'en_riesgo',     label: 'En riesgo',    fmtFn: fmtNum,   higherIsBetter: false },
  { key: 'sum_cargas',    label: 'Depósitos',    fmtFn: fmtMoney, higherIsBetter: true  },
  { key: 'sum_retiros',   label: 'Σ Retiros',    fmtFn: fmtMoney, higherIsBetter: false },
  { key: 'avg_cargas',    label: 'Saldo',        fmtFn: fmtMoney, higherIsBetter: true  },
  { key: 'response_rate', label: 'T. Respuesta', fmtFn: fmtPct,   higherIsBetter: true  },
  { key: 'reload_rate',   label: 'T. Recarga',   fmtFn: fmtPct,   higherIsBetter: true  },
]

// ── Aggregation ────────────────────────────────────────────────────────────────

type AggRow = Record<AggKey, number>

function aggregate(rows: CasinoAgente[]): AggRow {
  const s: AggRow = {
    total: 0, nuevos_mes: 0, activos_mes: 0, vip: 0,
    en_riesgo: 0, sum_cargas: 0, sum_retiros: 0, avg_cargas: 0,
    response_rate: 0, reload_rate: 0,
  }
  let reloadWeighted = 0
  for (const a of rows) {
    s.total         += a.total
    s.nuevos_mes    += a.nuevos_mes
    s.activos_mes   += a.activos_mes
    s.vip           += a.vip
    s.en_riesgo     += a.en_riesgo
    s.sum_cargas    += Number(a.sum_cargas)
    s.sum_retiros   += Number(a.sum_retiros)
    reloadWeighted  += Number(a.reload_rate) * a.total
  }
  s.avg_cargas    = s.total > 0 ? s.sum_cargas / s.total : 0
  // response_rate: weighted via activos_mes / total (avoids double-counting)
  s.response_rate = s.total > 0 ? (s.activos_mes / s.total) * 100 : 0
  // reload_rate: weighted average across agents
  s.reload_rate   = s.total > 0 ? reloadWeighted / s.total : 0
  return s
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-2 pt-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-11 rounded-lg bg-muted animate-pulse" />
      ))}
    </div>
  )
}

// ── usePeriodData ──────────────────────────────────────────────────────────────
// Self-contained hook: manages period state, validation and data fetch.
// Both pA and pB always fetch (even when compare mode is off) so switching
// modes is instant. The extra request is cheap and the data is tiny.

interface PeriodState {
  period:       Period
  customFrom:   string
  customTo:     string
  dateError:    string | null
  agentes:      CasinoAgente[]
  loading:      boolean
  setPeriod:    (p: Period) => void
  setCustomFrom: (v: string) => void
  setCustomTo:   (v: string) => void
}

function usePeriodData(
  platform: Platform,
  agentFilter: string,
  defaultPeriod: Period,
): PeriodState {
  // Initialize custom dates based on the default period so the inputs
  // show sensible values when the user switches to "Rango personalizado".
  const [period, setPeriod]         = useState<Period>(defaultPeriod)
  const [customFrom, setCustomFrom] = useState(() => resolveRange(defaultPeriod, '', '').from)
  const [customTo,   setCustomTo]   = useState(() => resolveRange(defaultPeriod, '', '').to)
  const [agentes,    setAgentes]    = useState<CasinoAgente[]>([])
  const [loading,    setLoading]    = useState(true)

  const dateError: string | null =
    period === 'custom' && customFrom > customTo
      ? '"Desde" no puede ser posterior a "Hasta"'
      : null

  const loadData = useCallback(async () => {
    // Skip fetch while date range is invalid — clear loading state
    if (period === 'custom' && customFrom > customTo) {
      setLoading(false)
      return
    }
    setLoading(true)
    const range      = resolveRange(period, customFrom, customTo)
    const agentQS    = agentFilter ? `&agent=${encodeURIComponent(agentFilter)}` : ''
    try {
      const res = await fetch(
        `/api/dashboard/casino?platform=${platform}&from=${range.from}&to=${range.to}${agentQS}`,
      )
      if (res.ok) {
        const data = await res.json() as { agentes?: CasinoAgente[] }
        setAgentes(data.agentes ?? [])
      }
    } catch { /* fail silently — table stays empty */ } finally {
      setLoading(false)
    }
  }, [platform, agentFilter, period, customFrom, customTo])

  useEffect(() => { void loadData() }, [loadData])

  return {
    period, customFrom, customTo, dateError, agentes, loading,
    setPeriod, setCustomFrom, setCustomTo,
  }
}

// ── PeriodPicker component ─────────────────────────────────────────────────────

interface PeriodPickerProps {
  label:          string       // e.g. "Per. A" — empty string hides the badge
  period:         Period
  customFrom:     string
  customTo:       string
  dateError:      string | null
  onPeriodChange: (p: Period) => void
  onFromChange:   (v: string) => void
  onToChange:     (v: string) => void
}

function PeriodPicker({
  label, period, customFrom, customTo, dateError,
  onPeriodChange, onFromChange, onToChange,
}: PeriodPickerProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {label && (
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted px-1.5 py-0.5 rounded">
            {label}
          </span>
        )}
        <Select value={period} onValueChange={(v: string | null) => onPeriodChange((v ?? 'mes_actual') as Period)}>
          <SelectTrigger size="sm" className="h-7 w-auto min-w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {(Object.keys(PERIOD_LABELS) as Period[]).map(p => (
              <SelectItem key={p} value={p} className="text-xs">
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {period === 'custom' && (
          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={customFrom}
              onChange={e => onFromChange(e.target.value)}
              className={cn(
                'h-7 w-[110px] text-xs px-2',
                dateError && 'border-rose-400 focus-visible:ring-rose-400',
              )}
              aria-label="Desde"
            />
            <span className="text-muted-foreground text-xs">→</span>
            <Input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={e => onToChange(e.target.value)}
              className="h-7 w-[110px] text-xs px-2"
              aria-label="Hasta"
            />
          </div>
        )}
      </div>

      {dateError && (
        <p className={cn('flex items-center gap-1 text-[11px] text-rose-500', label && 'ml-14')}>
          <AlertCircle className="w-3 h-3 shrink-0" />
          {dateError}
        </p>
      )}
    </div>
  )
}

// ── Normal table ───────────────────────────────────────────────────────────────

function NormalTable({ agentes }: { agentes: CasinoAgente[] }) {
  const HEADERS = ['Agente', 'Total', 'Nuevos', 'Activos', 'VIP', 'En riesgo', 'Depósitos', 'Σ Retiros', 'Saldo', 'T. Respuesta', 'T. Recarga']
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted">
            {HEADERS.map(h => (
              <th key={h} className="px-3 py-3 text-left font-semibold text-muted-foreground whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agentes.map(a => {
            const highRisk = a.total > 0 && (a.en_riesgo / a.total) > 0.3
            return (
              <tr
                key={a.agente}
                className={cn(
                  'border-b border-border/50 hover:bg-muted/50 transition-colors duration-200',
                  highRisk && 'bg-rose-50/50 dark:bg-rose-950/10',
                )}
              >
                <td className="px-3 py-3 font-medium capitalize">{a.agente}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtNum(a.total)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-emerald-600">{fmtNum(a.nuevos_mes)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-blue-600">{fmtNum(a.activos_mes)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-vip font-medium">{fmtNum(a.vip)}</td>
                <td className={cn(
                  'px-3 py-3 text-right tabular-nums font-medium',
                  highRisk ? 'text-rose-600' : 'text-muted-foreground',
                )}>
                  {fmtNum(a.en_riesgo)}
                  {highRisk && <span className="ml-1 text-[10px]">⚠</span>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(Number(a.sum_cargas))}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(Number(a.sum_retiros))}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                  {fmtMoney(Number(a.avg_cargas))}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {fmtPct(Number(a.response_rate))}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {fmtPct(Number(a.reload_rate))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Compare table ──────────────────────────────────────────────────────────────

interface CompareTableProps {
  agentesA: CasinoAgente[]
  agentesB: CasinoAgente[]
  labelA:   string
  labelB:   string
}

function CompareTable({ agentesA, agentesB, labelA, labelB }: CompareTableProps) {
  const rowA = aggregate(agentesA)
  const rowB = aggregate(agentesB)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted">
            <th className="px-3 py-3 text-left font-semibold text-muted-foreground whitespace-nowrap">
              Métrica
            </th>
            <th className="px-3 py-3 text-right font-semibold text-blue-600 whitespace-nowrap">
              {labelA}
            </th>
            <th className="px-3 py-3 text-right font-semibold text-purple-600 whitespace-nowrap">
              {labelB}
            </th>
            <th className="px-3 py-3 text-right font-semibold text-muted-foreground whitespace-nowrap">
              Diferencia
            </th>
            <th className="px-3 py-3 text-right font-semibold text-muted-foreground whitespace-nowrap">
              % Cambio
            </th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map(({ key, label, fmtFn, higherIsBetter }) => {
            const valA = rowA[key]
            const valB = rowB[key]
            const diff = valA - valB
            // If B is 0: show 100% if A > 0, else 0%
            const pct  = valB !== 0 ? (diff / Math.abs(valB)) * 100 : (valA !== 0 ? 100 : 0)
            const isGood = diff === 0
              ? null
              : (higherIsBetter ? diff > 0 : diff < 0)
            const diffColor = isGood === null
              ? 'text-muted-foreground'
              : isGood ? 'text-emerald-600' : 'text-rose-600'
            const sign = diff > 0 ? '+' : ''

            return (
              <tr
                key={key}
                className="border-b border-border/50 hover:bg-muted/50 transition-colors duration-200"
              >
                <td className="px-3 py-3 font-medium text-foreground">{label}</td>
                <td className="px-3 py-3 text-right tabular-nums font-medium text-blue-600">
                  {fmtFn(valA)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums font-medium text-purple-600">
                  {fmtFn(valB)}
                </td>
                <td className={cn('px-3 py-3 text-right tabular-nums font-medium', diffColor)}>
                  {sign}{fmtFn(diff)}
                </td>
                <td className={cn('px-3 py-3 text-right tabular-nums font-medium', diffColor)}>
                  {sign}{pct.toFixed(1)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Widget ─────────────────────────────────────────────────────────────────────

interface Props {
  platform:    Platform
  agentFilter: string
}

export const AgentesTableWidget = memo(function AgentesTableWidget({ platform, agentFilter }: Props) {
  const [compareMode, setCompareMode] = useState(false)

  // Both periods always fetch so toggling compare mode is instant
  const pA = usePeriodData(platform, agentFilter, 'mes_actual')
  const pB = usePeriodData(platform, agentFilter, 'mes_anterior')

  const hasDateError = pA.dateError !== null || (compareMode && pB.dateError !== null)
  const isLoading    = pA.loading || (compareMode && pB.loading)

  return (
    <Card>
      {/* ── Header ── */}
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="w-4 h-4 text-primary" />
            Rendimiento por agente
          </CardTitle>

          <Button
            variant={compareMode ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs gap-1.5 px-2.5"
            onClick={() => setCompareMode(m => !m)}
          >
            {compareMode
              ? <><X className="w-3 h-3" /> Cerrar comparación</>
              : <><GitCompare className="w-3 h-3" /> Comparar</>
            }
          </Button>
        </div>

        {/* Period picker(s) */}
        <div className={cn('mt-2 space-y-2', compareMode && 'pt-2 border-t border-border')}>
          {compareMode ? (
            <>
              <PeriodPicker
                label="Per. A"
                period={pA.period}
                customFrom={pA.customFrom}
                customTo={pA.customTo}
                dateError={pA.dateError}
                onPeriodChange={pA.setPeriod}
                onFromChange={pA.setCustomFrom}
                onToChange={pA.setCustomTo}
              />
              <PeriodPicker
                label="Per. B"
                period={pB.period}
                customFrom={pB.customFrom}
                customTo={pB.customTo}
                dateError={pB.dateError}
                onPeriodChange={pB.setPeriod}
                onFromChange={pB.setCustomFrom}
                onToChange={pB.setCustomTo}
              />
            </>
          ) : (
            <PeriodPicker
              label=""
              period={pA.period}
              customFrom={pA.customFrom}
              customTo={pA.customTo}
              dateError={pA.dateError}
              onPeriodChange={pA.setPeriod}
              onFromChange={pA.setCustomFrom}
              onToChange={pA.setCustomTo}
            />
          )}
        </div>
      </CardHeader>

      {/* ── Body ── */}
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-4 pb-4"><Skeleton /></div>
        ) : hasDateError ? (
          <div className="flex items-center gap-2 text-rose-500 text-xs px-4 pb-4">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Corregí las fechas inválidas para ver los datos.
          </div>
        ) : compareMode ? (
          <CompareTable
            agentesA={pA.agentes}
            agentesB={pB.agentes}
            labelA={periodDisplayLabel(pA.period, pA.customFrom, pA.customTo)}
            labelB={periodDisplayLabel(pB.period, pB.customFrom, pB.customTo)}
          />
        ) : pA.agentes.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 pb-4">Sin datos de agentes</p>
        ) : (
          <NormalTable agentes={pA.agentes} />
        )}
      </CardContent>
    </Card>
  )
})
