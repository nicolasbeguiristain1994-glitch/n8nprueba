'use client'

import { TrendingUp, TrendingDown, Minus, ChartNoAxesCombined } from 'lucide-react'
import type { AgentSalesComparison, AgentSalesRow } from '@/lib/dashboard-casino'
import { formatDay, queryDateRange } from '@/lib/dashboard-date-range'
import { formatPesos } from '@/lib/dashboard-format'
import type { Platform } from '@/lib/casino-agents'
import type { DateRange } from './types'

const PLATFORMS: Record<Platform, string> = {
  consolidado: 'Todas las plataformas', zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet',
}

function SalesChange({ row }: { row: AgentSalesRow }) {
  const difference = Number(row.difference)
  const Icon = difference > 0 ? TrendingUp : difference < 0 ? TrendingDown : Minus
  const sign = difference > 0 ? '+' : difference < 0 ? '−' : ''
  const color = difference > 0 ? 'text-emerald-700 dark:text-emerald-400'
    : difference < 0 ? 'text-rose-700 dark:text-rose-400' : 'text-muted-foreground'
  const change = row.change_percentage === null ? 'Sin base anterior'
    : `${sign}${Math.abs(Number(row.change_percentage)).toLocaleString('es-AR', { maximumFractionDigits: 1 })}%`
  return <div className={`mt-2 text-xs tabular-nums ${color}`}>
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <Icon size={13} aria-hidden="true" className="shrink-0" />
      <span className="font-semibold">{change}</span>
      <span>({sign}{formatPesos(Math.abs(difference))})</span>
    </p>
    <p className="mt-1 text-muted-foreground">Anterior: {formatPesos(row.previous_amount)}</p>
  </div>
}

export function SalesByAgent({ comparison, loading, dateRange, platform, agent }: {
  comparison: AgentSalesComparison | null
  loading: boolean
  dateRange: DateRange
  platform: Platform
  agent: string
}) {
  if (agent) return null
  const range = queryDateRange(dateRange)
  const rows = [...(comparison?.rows ?? [])].sort((a,b) => Number(b.amount)-Number(a.amount) || a.agente.localeCompare(b.agente,'es'))
  const total = rows.reduce((sum,row) => sum+Number(row.amount),0)
  return <section aria-label="Ventas por agente" className="surface mb-6 overflow-hidden">
    <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ChartNoAxesCombined size={20} className="shrink-0 text-primary" aria-hidden="true" />Ventas por agente
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Depósitos sin bonos · {PLATFORMS[platform]}</p>
        <p className="mt-1 text-xs text-muted-foreground">{formatDay(range.from)} al {formatDay(range.to)}
          {comparison && <> · Comparado con {formatDay(comparison.previous.from)} al {formatDay(comparison.previous.to)} (mes anterior)</>}
        </p>
      </div>
      <div className="max-w-full self-start rounded-xl bg-primary/10 px-4 py-3 text-right sm:self-auto">
        <p className="text-xs font-medium text-primary">Ventas del período</p>
        <p className="mt-1 break-words text-xl font-semibold tracking-tight tabular-nums">{loading || !comparison ? '—' : formatPesos(total)}</p>
      </div>
    </div>
    {loading ? <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">Consultando ventas por agente…</p>
      : !comparison ? <p className="px-5 pb-4 text-sm text-muted-foreground">Comparativa no disponible. Reintentá con Actualizar.</p>
      : rows.length === 0 ? <p className="px-5 pb-4 text-sm text-muted-foreground">Sin ventas registradas para estos períodos.</p>
      : <dl className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(row => {
          const share = total > 0 ? Number(row.amount)/total*100 : 0
          return <div key={row.agente} className="min-w-0 rounded-lg border bg-muted/15 p-3">
            <dt className="truncate text-sm font-medium capitalize" title={row.agente}>{row.agente}</dt>
            <dd className="mt-2">
              <p className="break-words text-xl font-semibold tabular-nums">{formatPesos(row.amount)}</p>
              <SalesChange row={row} />
              <p className="mt-2 text-xs text-muted-foreground tabular-nums">{share.toLocaleString('es-AR',{maximumFractionDigits:1})}% del total</p>
              <div aria-hidden="true" className="mt-1 h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-primary" style={{width:`${Math.max(0,Math.min(100,share))}%`}} /></div>
            </dd>
          </div>
        })}
      </dl>}
  </section>
}
