'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CasinoAgente } from '@/app/api/dashboard/casino/route'

interface Props {
  agentes: CasinoAgente[]
  loading?: boolean
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`
  return `$${n.toLocaleString('es-AR')}`
}

function Skeleton() {
  return (
    <div className="space-y-2 pt-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-9 rounded-lg bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const AgentesTableWidget = memo(function AgentesTableWidget({ agentes, loading }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="w-4 h-4 text-violet-500" />
          Rendimiento por agente
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-4 pb-4"><Skeleton /></div>
        ) : agentes.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 pb-4">Sin datos de agentes</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['Agente','Total','Nuevos','Activos','VIP','En riesgo','Σ Cargas','Σ Retiros','Avg carga'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
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
                        'border-b border-border/50 hover:bg-muted/30 transition-colors',
                        highRisk && 'bg-rose-50/50 dark:bg-rose-950/10',
                      )}
                    >
                      <td className="px-3 py-2 font-medium capitalize">{a.agente}</td>
                      <td className="px-3 py-2 text-right">{a.total.toLocaleString('es-AR')}</td>
                      <td className="px-3 py-2 text-right text-emerald-600">{a.nuevos_mes}</td>
                      <td className="px-3 py-2 text-right text-blue-600">{a.activos_mes}</td>
                      <td className="px-3 py-2 text-right text-amber-600 font-medium">{a.vip}</td>
                      <td className={cn('px-3 py-2 text-right font-medium', highRisk ? 'text-rose-600' : 'text-muted-foreground')}>
                        {a.en_riesgo}
                        {highRisk && <span className="ml-1 text-[10px]">⚠</span>}
                      </td>
                      <td className="px-3 py-2 text-right">{fmt(Number(a.sum_cargas))}</td>
                      <td className="px-3 py-2 text-right">{fmt(Number(a.sum_retiros))}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{fmt(Number(a.avg_cargas))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
