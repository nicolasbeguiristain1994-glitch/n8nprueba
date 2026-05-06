'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DealClosingSoon } from '@/app/api/dashboard/crm/route'

interface Props {
  deals: DealClosingSoon[]
  loading?: boolean
}

function fmt(n: number | null) {
  if (n == null) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString('es-AR')}`
}

function urgencyClass(days: number) {
  if (days <= 2) return 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400'
  if (days <= 5) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
  return 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400'
}

const STAGE_LABELS: Record<string, string> = {
  calificado: 'Calificado', propuesta: 'Propuesta',
  negociacion: 'Negociación', cierre: 'Cierre',
}

export const DealsClosingSoonWidget = memo(function DealsClosingSoonWidget({ deals, loading }: Props) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-amber-500" />
          Cierres próximos
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : deals.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <CalendarClock className="w-8 h-8 opacity-30" />
            <p className="text-sm">Sin cierres en los próximos 14 días</p>
          </div>
        ) : (
          <div className="space-y-2">
            {deals.map(deal => (
              <div
                key={deal.id}
                className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className={cn('text-center px-2 py-1 rounded-lg min-w-[44px]', urgencyClass(deal.days_left))}>
                  <p className="text-xs font-bold leading-none tabular-nums">{deal.days_left}</p>
                  <p className="text-[10px] leading-none mt-0.5">días</p>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{deal.title}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {deal.contact_name ?? 'Sin contacto'} · {STAGE_LABELS[deal.stage] ?? deal.stage}
                  </p>
                </div>
                <span className="text-sm font-semibold shrink-0 tabular-nums">{fmt(deal.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
})
