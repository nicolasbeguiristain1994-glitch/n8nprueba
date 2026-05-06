'use client'

import { memo } from 'react'
import { Users, CheckSquare, AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { CrmKPIs } from '@/app/api/dashboard/crm/route'

interface KPIWidgetProps {
  kpis: CrmKPIs
  loading?: boolean
}

const CARDS = (kpis: CrmKPIs) => [
  {
    label: 'Contactos',
    value: kpis.contacts.toLocaleString('es-AR'),
    sub:   'Total en CRM',
    icon:  Users,
    color: 'text-blue-500',
    bg:    'bg-blue-50 dark:bg-blue-950/30',
  },
  {
    label: 'Tareas pendientes',
    value: kpis.tasks_pending.toString(),
    sub:   kpis.tasks_overdue > 0 ? `${kpis.tasks_overdue} vencidas` : 'Al día',
    icon:  kpis.tasks_overdue > 0 ? AlertTriangle : CheckSquare,
    color: kpis.tasks_overdue > 0 ? 'text-rose-500' : 'text-teal-500',
    bg:    kpis.tasks_overdue > 0 ? 'bg-rose-50 dark:bg-rose-950/30' : 'bg-teal-50 dark:bg-teal-950/30',
  },
]

function Skeleton() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="h-28 rounded-[20px] bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const KPIWidget = memo(function KPIWidget({ kpis, loading }: KPIWidgetProps) {
  if (loading) return <Skeleton />

  const cards = CARDS(kpis)

  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Card
            key={card.label}
            size="sm"
            className="gap-0 py-4 rounded-[20px] shadow-xl hover:-translate-y-0.5 hover:shadow-2xl transition-all duration-200 cursor-default"
          >
            <CardContent className="flex flex-col gap-3">
              <div className={cn('w-10 h-10 rounded-full flex items-center justify-center', card.bg)}>
                <Icon className={cn('w-5 h-5', card.color)} />
              </div>
              <div>
                <p className="text-[34px] font-semibold tracking-tighter leading-none">{card.value}</p>
                <p className="text-xs text-muted-foreground mt-1.5">{card.label}</p>
                <p className="text-xs text-muted-foreground/70 mt-0.5">{card.sub}</p>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
})
