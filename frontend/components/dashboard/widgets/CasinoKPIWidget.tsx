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
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-28 rounded-xl bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const CasinoKPIWidget = memo(function CasinoKPIWidget({ summary, loading }: Props) {
  if (loading) return <Skeleton />

  if (!summary) return <p className="p-4 text-sm text-muted-foreground">Indicadores de cuentas no disponibles.</p>
  const s = summary

  const cards = [
    {
      label: 'Primer depósito en período',
      value: s.nuevos_mes.toLocaleString('es-AR'),
      sub:   <Delta current={s.nuevos_mes} previous={s.nuevos_anterior} />,
      icon:  UserPlus,
      color: 'text-emerald-500',
      bg:    'bg-emerald-50 dark:bg-emerald-950/30',
    },
    {
      label: 'Con movimientos en período',
      value: s.activos_mes.toLocaleString('es-AR'),
      sub:   <Delta current={s.activos_mes} previous={s.activos_anterior} />,
      icon:  TrendingUp,
      color: 'text-blue-500',
      bg:    'bg-blue-50 dark:bg-blue-950/30',
    },
    {
      label: 'Total VIP',
      value: s.total_vip.toLocaleString('es-AR'),
      sub:   <span className="text-xs text-muted-foreground">Todos los niveles · estado actual</span>,
      icon:  Crown,
      color: 'text-vip',
      bg:    'bg-vip/10 dark:bg-vip/[.07]',
    },
    {
      label: 'Reactivación urgente',
      value: s.prioridad_reactivacion.toLocaleString('es-AR'),
      sub:   <span className="text-xs text-muted-foreground">VIP en riesgo · estado actual</span>,
      icon:  AlertTriangle,
      color: s.prioridad_reactivacion > 0 ? 'text-rose-500' : 'text-slate-400',
      bg:    s.prioridad_reactivacion > 0 ? 'bg-rose-50 dark:bg-rose-950/30' : 'bg-background dark:bg-slate-800/30',
    },
    {
      label: 'Cuentas clasificadas',
      value: s.total_jugadores.toLocaleString('es-AR'),
      sub:   <span className="text-xs text-muted-foreground">Historial disponible</span>,
      icon:  Users,
      color: 'text-primary',
      bg:    'bg-primary/10 dark:bg-primary/[.07]',
    },
  ]

  return (
    <div>
    <p className="mb-2 text-xs text-muted-foreground">Primer depósito y actividad: período elegido, comparado con el anterior de igual duración. VIP, riesgo y cuentas: estado actual; dependen del historial disponible.</p>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      {cards.map(card => {
        const Icon = card.icon
        return (
          <Card
            key={card.label}
            size="sm"
            className="gap-0 py-4 rounded-xl shadow-xs cursor-default"
          >
            <CardContent className="flex flex-col gap-2">
              <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', card.bg)}>
                <Icon className={cn('w-4 h-4', card.color)} />
              </div>
              <div>
                <p className="text-[28px] font-semibold tracking-tighter leading-none">{card.value}</p>
                <p className="text-xs text-muted-foreground mt-1.5">{card.label}</p>
                <div className="mt-0.5">{card.sub}</div>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
    </div>
  )
})
