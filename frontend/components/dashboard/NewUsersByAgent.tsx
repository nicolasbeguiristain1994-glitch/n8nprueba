'use client'

import { UserPlus } from 'lucide-react'
import type { CasinoAgente } from '@/app/api/dashboard/casino/route'
import { describeDateRange } from '@/lib/dashboard-date-range'
import type { Platform } from '@/lib/casino-agents'
import type { DateRange } from './types'

const PLATFORM_LABELS: Record<Platform, string> = {
  consolidado: 'Todas las plataformas', zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet',
}

export function NewUsersByAgent({ agentes, loading, dateRange, platform, agent }: {
  agentes: CasinoAgente[] | null
  loading: boolean
  dateRange: DateRange
  platform: Platform
  agent: string
}) {
  const rows = [...(agentes ?? [])].sort((a, b) => b.nuevos_mes - a.nuevos_mes || (a.agente ?? '').localeCompare(b.agente ?? '', 'es'))
  const total = rows.reduce((sum, row) => sum + row.nuevos_mes, 0)
  return (
    <section aria-label="Usuarios nuevos por agente" className="surface mb-6 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <UserPlus size={20} className="shrink-0 text-primary" aria-hidden="true" />Usuarios nuevos por agente
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Primer depósito registrado en el período</p>
          <p className="mt-1 text-xs text-muted-foreground">{describeDateRange(dateRange)} · {PLATFORM_LABELS[platform]} · {agent || 'Todos los agentes'}</p>
        </div>
        <div className="rounded-xl bg-primary/10 px-5 py-3 text-right">
          <p className="text-xs font-medium text-primary">Total del período</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{loading || !agentes ? '—' : total.toLocaleString('es-AR')}</p>
        </div>
      </div>
      {loading ? <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">Consultando usuarios nuevos…</p>
        : !agentes ? <p className="px-5 pb-4 text-sm text-muted-foreground">Usuarios nuevos no disponibles. Reintentá con Refrescar vista.</p>
        : <>
          {total === 0 && <p className="px-5 pb-4 text-sm text-muted-foreground">No hay primeros depósitos registrados para este período y estos filtros.</p>}
          {rows.length > 0 && <dl className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-4">
            {rows.map(row => {
              const share = total > 0 ? row.nuevos_mes / total * 100 : 0
              return <div key={row.agente ?? 'sin-agente'} className="min-w-0 rounded-lg border bg-muted/15 p-3">
                <dt className="truncate text-sm font-medium capitalize" title={row.agente || 'Sin agente'}>{row.agente || 'Sin agente'}</dt>
                <dd className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="text-2xl font-semibold tabular-nums">{row.nuevos_mes.toLocaleString('es-AR')}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{share.toLocaleString('es-AR', { maximumFractionDigits: 1 })}% del total</span>
                </dd>
                <div aria-hidden="true" className="mt-2 h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-primary" style={{ width: `${share}%` }} /></div>
              </div>
            })}
          </dl>}
        </>}
      <p className="border-t bg-muted/15 px-5 py-3 text-xs leading-relaxed text-muted-foreground">Cada cuenta se atribuye al agente de su primer depósito disponible en el historial. Una persona con cuentas en distintas plataformas puede contarse más de una vez.</p>
    </section>
  )
}
