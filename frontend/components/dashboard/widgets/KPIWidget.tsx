'use client'

import { memo } from 'react'
import { TrendingUp, Users, BadgeDollarSign, CheckSquare, AlertTriangle, Trophy } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { CrmKPIs } from '@/app/api/dashboard/crm/route'

interface KPIWidgetProps {
  kpis: CrmKPIs
  loading?: boolean
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString('es-AR')}`
}

const CARDS = (kpis: CrmKPIs) => [
  {
    label:   'Deals activos',
    value:   kpis.total_deals.toString(),
    sub:     `Valor: ${fmt(kpis.total_deals_value)}`,
    icon:    TrendingUp,
    color:   'text-violet-500',
    bg:      'bg-violet-50 dark:bg-violet-950/30',
  },
  {
    label:   'Deals ganados',
    value:   kpis.won_deals.toString(),
    sub:     fmt(kpis.won_deals_value),
    icon:    Trophy,
    color:   'text-emerald-500',
    bg:      'bg-emerald-50 dark:bg-emerald-950/30',
  },
  {
    label:   'Contactos',
    value:   kpis.contacts.toLocaleString('es-AR'),
    sub:     'Total en CRM',
    icon:    Users,
    color:   'text-blue-500',
    bg:      'bg-blue-50 dark:bg-blue-950/30',
  },
  {
    label:   'Conversión',
    value:   `${kpis.conversion_rate}%`,
    sub:     'Deals ganados / total',
    icon:    BadgeDollarSign,
    color:   'text-amber-500',
    bg:      'bg-amber-50 dark:bg-amber-950/30',
  },
  {
    label:   'Tareas pendientes',
    value:   kpis.tasks_pending.toString(),
    sub:     kpis.tasks_overdue > 0 ? `${kpis.tasks_overdue} vencidas` : 'Al día',
    icon:    kpis.tasks_overdue > 0 ? AlertTriangle : CheckSquare,
    color:   kpis.tasks_overdue > 0 ? 'text-rose-500' : 'text-teal-500',
    bg:      kpis.tasks_overdue > 0 ? 'bg-rose-50 dark:bg-rose-950/30' : 'bg-teal-50 dark:bg-teal-950/30',
  },
]

function Skeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const KPIWidget = memo(function KPIWidget({ kpis, loading }: KPIWidgetProps) {
  if (loading) return <Skeleton />

  const cards = CARDS(kpis)

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Card key={card.label} size="sm" className="gap-0 py-4">
            <CardContent className="flex flex-col gap-3">
              <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', card.bg)}>
                <Icon className={cn('w-4 h-4', card.color)} />
              </div>
              <div>
                <p className="text-2xl font-bold tracking-tight">{card.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.label}</p>
                <p className="text-xs text-muted-foreground/70 mt-0.5">{card.sub}</p>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
})
