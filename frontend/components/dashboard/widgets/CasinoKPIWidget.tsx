'use client'

import { memo } from 'react'
import { Users, Crown, AlertTriangle, TrendingUp, TrendingDown, UserPlus } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { CasinoSummary } from '@/app/api/dashboard/casino/route'

interface Props {
  summary: CasinoSummary | null
  loading?: boolean
}

function Delta({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return null
  const diff = current - previous
  const pct  = Math.round(Math.abs(diff / previous) * 100)
  const up   = diff >= 0
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span className={cn('flex items-center gap-0.5 text-xs font-medium', up ? 'text-emerald-600' : 'text-rose-500')}>
      <Icon className="w-3 h-3" />
      {pct}%
    </span>
  )
}

function Skeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const CasinoKPIWidget = memo(function CasinoKPIWidget({ summary, loading }: Props) {
  if (loading) return <Skeleton />

  const s = summary ?? {
    nuevos_mes: 0, nuevos_anterior: 0,
    activos_mes: 0, activos_anterior: 0,
    total_vip: 0, prioridad_reactivacion: 0, total_jugadores: 0,
  }

  const cards = [
    {
      label: 'Nuevos este mes',
      value: s.nuevos_mes.toLocaleString('es-AR'),
      sub:   <Delta current={s.nuevos_mes} previous={s.nuevos_anterior} />,
      icon:  UserPlus,
      color: 'text-emerald-500',
      bg:    'bg-emerald-50 dark:bg-emerald-950/30',
    },
    {
      label: 'Activos este mes',
      value: s.activos_mes.toLocaleString('es-AR'),
      sub:   <Delta current={s.activos_mes} previous={s.activos_anterior} />,
      icon:  TrendingUp,
      color: 'text-blue-500',
      bg:    'bg-blue-50 dark:bg-blue-950/30',
    },
    {
      label: 'Total VIP',
      value: s.total_vip.toLocaleString('es-AR'),
      sub:   <span className="text-xs text-muted-foreground">seg_monto = vip</span>,
      icon:  Crown,
      color: 'text-amber-500',
      bg:    'bg-amber-50 dark:bg-amber-950/30',
    },
    {
      label: 'Reactivación urgente',
      value: s.prioridad_reactivacion.toLocaleString('es-AR'),
      sub:   <span className="text-xs text-muted-foreground">VIP/Alto inactivos</span>,
      icon:  AlertTriangle,
      color: s.prioridad_reactivacion > 0 ? 'text-rose-500' : 'text-slate-400',
      bg:    s.prioridad_reactivacion > 0 ? 'bg-rose-50 dark:bg-rose-950/30' : 'bg-slate-50 dark:bg-slate-800/30',
    },
    {
      label: 'Total jugadores',
      value: s.total_jugadores.toLocaleString('es-AR'),
      sub:   <span className="text-xs text-muted-foreground">en base</span>,
      icon:  Users,
      color: 'text-violet-500',
      bg:    'bg-violet-50 dark:bg-violet-950/30',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map(card => {
        const Icon = card.icon
        return (
          <Card key={card.label} size="sm" className="gap-0 py-4">
            <CardContent className="flex flex-col gap-2">
              <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', card.bg)}>
                <Icon className={cn('w-4 h-4', card.color)} />
              </div>
              <div>
                <p className="text-2xl font-bold tracking-tight">{card.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.label}</p>
                <div className="mt-0.5">{card.sub}</div>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
})
