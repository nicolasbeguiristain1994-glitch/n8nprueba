'use client'

import { memo, useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Users, GitCompare, X, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { argentinaToday, shiftDate } from '@/lib/dashboard-format'
import { describeDateRange, exclusiveEndDate, queryDateRange, validCustomRange } from '@/lib/dashboard-date-range'
import type { DateRange } from '../types'
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

// Month presets are inclusive full days; custom uses the dashboard rule
// [from 00:00, to 00:00). Returns inclusive DATE endpoints for the API, or null if invalid.
function resolveRange(period: Period, from: string, to: string): { from: string; to: string } | null {
  if (period === 'custom') return validCustomRange(from, to) ? queryDateRange({ preset: 'custom', from, to }) : null
  const today = argentinaToday()
  const first = `${today.slice(0, 7)}-01`
  const lastMonth = shiftDate(first, -1)
  return period === 'mes_actual' ? { from: first, to: today } : { from: `${lastMonth.slice(0, 7)}-01`, to: lastMonth }
}

/** Custom inputs covering the same days as a month preset (exclusive end). */
function customBounds(period: Exclude<Period, 'custom'>): { from: string; to: string } {
  const range = resolveRange(period, '', '')!
  return { from: range.from, to: exclusiveEndDate({ preset: period, ...range }) }
}

function periodDisplayLabel(period: Period, from: string, to: string): string {
  if (period !== 'custom') return PERIOD_LABELS[period]
  return describeDateRange({ preset: 'custom', from, to })
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
  { key: 'total',         label: 'Cuentas',        fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'nuevos_mes',    label: 'Primer depósito',       fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'activos_mes',   label: 'Activos',      fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'vip',           label: 'VIP',          fmtFn: fmtNum,   higherIsBetter: true  },
  { key: 'en_riesgo',     label: 'En riesgo',    fmtFn: fmtNum,   higherIsBetter: false },
  { key: 'sum_cargas',    label: 'Depósitos',    fmtFn: fmtMoney, higherIsBetter: true  },
  { key: 'sum_retiros',   label: 'Σ Retiros',    fmtFn: fmtMoney, higherIsBetter: false },
  { key: 'avg_cargas',    label: 'Depósito por cuenta',        fmtFn: fmtMoney, higherIsBetter: true  },
  { key: 'response_rate', label: '% con movimientos', fmtFn: fmtPct,   higherIsBetter: true  },
  { key: 'reload_rate',   label: '% con depósitos',   fmtFn: fmtPct,   higherIsBetter: true  },
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
// The comparison period is only fetched while the comparison is visible.

interface PeriodState {
  period:       Period
  customFrom:   string
  customTo:     string
  dateError:    string | null
  error: string | null
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
  revision: number,
  enabled = true,
  /** Custom bounds with an exclusive end, e.g. the dashboard range via exclusiveEndDate. */
  initialRange?: { from: string; to: string },
): PeriodState {
  // Initialize custom dates based on the default period so the inputs
  // show sensible values when the user switches to "Rango personalizado".
  const [period, setPeriod]         = useState<Period>(defaultPeriod)
  const seed = () => initialRange ?? customBounds(defaultPeriod === 'custom' ? 'mes_actual' : defaultPeriod)
  const [customFrom, setCustomFrom] = useState(() => seed().from)
  const [customTo,   setCustomTo]   = useState(() => seed().to)
  const [agentes,    setAgentes]    = useState<CasinoAgente[]>([])
  const [loading,    setLoading]    = useState(true)

  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (initialRange) { setPeriod('custom'); setCustomFrom(initialRange.from); setCustomTo(initialRange.to) }
  }, [initialRange?.from, initialRange?.to])
  const range = resolveRange(period, customFrom, customTo)
  const dateError = range ? null : 'Elegí un período válido: Desde debe ser anterior a Hasta (00:00, no incluido)'
  const queryFrom = range?.from ?? '', queryTo = range?.to ?? ''
  useEffect(() => {
    const controller = new AbortController()
    if (!enabled || dateError) { setLoading(false); return }
    setLoading(true); setError(null)
    const qs = new URLSearchParams({ platform, agent: agentFilter, from: queryFrom, to: queryTo })
    async function load() {
      try {
        const res = await fetch(`/api/dashboard/casino?${qs}`, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error('No se pudo consultar el rendimiento por agente')
        const data = await res.json()
        if (!controller.signal.aborted) setAgentes(data.agentes ?? [])
      } catch (e) {
        if (!controller.signal.aborted) { setAgentes([]); setError(e instanceof Error ? e.message : 'Error de consulta') }
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    const timer = setTimeout(() => { void load() }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [platform, agentFilter, queryFrom, queryTo, dateError, revision, enabled])
  return { period, customFrom, customTo, dateError, error, agentes, loading, setPeriod, setCustomFrom, setCustomTo }
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
  const [from, setFrom] = useState(customFrom)
  const [to, setTo] = useState(customTo)
  useEffect(() => { setFrom(customFrom); setTo(customTo) }, [customFrom, customTo])
  const pending = from !== customFrom || to !== customTo
  const draftValid = validCustomRange(from, to)
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
            <SelectValue>{PERIOD_LABELS[period]}</SelectValue>
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
              value={from}
              onChange={e => setFrom(e.target.value)}
              className={cn(
                'h-7 w-[110px] text-xs px-2',
                dateError && 'border-rose-400 focus-visible:ring-rose-400',
              )}
              aria-label={`Desde ${label}`}
            />
            <span className="text-muted-foreground text-xs">00:00 →</span>
            <Input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="h-7 w-[110px] text-xs px-2"
              aria-label={`Hasta ${label}`}
            />
            <span className="text-muted-foreground text-xs">00:00 (no incluido)</span>
            <Button size="sm" className="h-7 text-xs" disabled={!pending || !draftValid} onClick={() => { onFromChange(from); onToChange(to) }}>Aplicar {label}</Button>
            {pending && !draftValid && <span role="alert" className="text-xs text-destructive">Completá un rango válido.</span>}
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
  const HEADERS = ['Agente', ...METRICS.map(metric => metric.label)]
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
  agentes: CasinoAgente[] | null
  loading: boolean
  dateRange: DateRange
  revision: number
}

export const AgentesTableWidget = memo(function AgentesTableWidget({ platform, agentFilter, dateRange, revision, agentes, loading }: Props) {
  const [compareMode, setCompareMode] = useState(false)

  // Period A follows the global range; period B is loaded on demand.
  // Expressed as custom bounds, so it queries exactly the dashboard's days.
  const pA = usePeriodData(platform, agentFilter, 'custom', revision, compareMode, { from: dateRange.from, to: exclusiveEndDate(dateRange) })
  const pB = usePeriodData(platform, agentFilter, 'mes_anterior', revision, compareMode)

  const hasDateError = pA.dateError !== null || (compareMode && pB.dateError !== null)
  const isLoading = compareMode ? pA.loading || pB.loading : loading
  const rows = compareMode ? pA.agentes : (agentes ?? [])
  const error = compareMode ? pA.error || pB.error : (!loading && !agentes ? 'No se pudo consultar el rendimiento por agente. Reintentá con Refrescar vista.' : null)

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

        <p className="text-xs text-muted-foreground">El período A sigue la selección del dashboard y se puede ajustar aquí para comparar. VIP y riesgo reflejan el estado actual, no una foto histórica.</p>
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
            <p className="text-xs text-muted-foreground">{describeDateRange(dateRange)} · Período del dashboard</p>
          )}
        </div>
      </CardHeader>

      {/* ── Body ── */}
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-4 pb-4"><Skeleton /></div>
        ) : error ? (
          <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
        ) : compareMode && hasDateError ? (
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
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 pb-4">Sin datos de agentes</p>
        ) : (
          <NormalTable agentes={rows} />
        )}
      </CardContent>
    </Card>
  )
})
