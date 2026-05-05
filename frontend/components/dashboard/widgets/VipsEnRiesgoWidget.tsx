'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Crown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CasinoVip } from '@/app/api/dashboard/casino/route'

interface Props {
  vips:    CasinoVip[]
  loading?: boolean
}

const ACT_STYLE: Record<string, string> = {
  perdido:   'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  inactivo:  'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400',
  en_riesgo: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-400',
  ocasional: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

const MONTO_STYLE: Record<string, string> = {
  vip:  'bg-amber-100 text-amber-700 border border-amber-300',
  alto: 'bg-slate-100 text-slate-600 border border-slate-300',
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`
  return `$${n.toLocaleString('es-AR')}`
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const VipsEnRiesgoWidget = memo(function VipsEnRiesgoWidget({ vips, loading }: Props) {
  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Crown className="w-4 h-4 text-amber-500" />
          VIPs en riesgo
          {!loading && vips.length > 0 && (
            <span className="ml-auto text-xs font-normal text-muted-foreground">{vips.length} jugadores</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto max-h-80">
        {loading ? (
          <Skeleton />
        ) : vips.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <Crown className="w-8 h-8 opacity-30" />
            <p className="text-sm">Sin VIPs en riesgo</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {vips.slice(0, 20).map(v => (
              <div
                key={v.username}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium truncate">{v.username}</span>
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', MONTO_STYLE[v.seg_monto] ?? 'bg-slate-100 text-slate-600')}>
                      {v.seg_monto.toUpperCase()}
                    </span>
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', ACT_STYLE[v.seg_actividad] ?? 'bg-slate-100 text-slate-600')}>
                      {v.seg_actividad.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">{v.agente}</span>
                    <span className="text-[10px] text-muted-foreground">·</span>
                    <span className="text-[10px] text-muted-foreground">{fmt(v.total_cargas)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className={cn(
                    'text-xs font-medium',
                    v.dias_ultimo > 60 ? 'text-rose-600' : v.dias_ultimo > 30 ? 'text-orange-500' : 'text-yellow-600',
                  )}>
                    {v.dias_ultimo}d
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
})
