'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MessageSquare, Send, XCircle, Eye, MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MsgsStats } from '../useDashboard'

interface Props {
  msgs:    MsgsStats | null
  loading?: boolean
}

function Skeleton() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-20 rounded-xl bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export const MensajeriaWidget = memo(function MensajeriaWidget({ msgs, loading }: Props) {
  const m = msgs ?? { last_24h: 0, sent: 0, failed: 0, read_rate: 0, inbound: 0, total: 0, delivered: 0, read: 0 }

  const cards = [
    {
      label: 'Enviados (24h)',
      value: Number(m.last_24h).toLocaleString('es-AR'),
      icon:  Send,
      color: 'text-blue-500',
      bg:    'bg-blue-50 dark:bg-blue-950/30',
    },
    {
      label: 'Tasa de lectura',
      value: `${m.read_rate ?? 0}%`,
      icon:  Eye,
      color: 'text-emerald-500',
      bg:    'bg-emerald-50 dark:bg-emerald-950/30',
    },
    {
      label: 'Fallidos',
      value: Number(m.failed).toLocaleString('es-AR'),
      icon:  XCircle,
      color: Number(m.failed) > 0 ? 'text-rose-500' : 'text-slate-400',
      bg:    Number(m.failed) > 0 ? 'bg-rose-50 dark:bg-rose-950/30' : 'bg-slate-50 dark:bg-slate-800/30',
    },
    {
      label: 'Respuestas',
      value: Number(m.inbound).toLocaleString('es-AR'),
      icon:  MessageCircle,
      color: 'text-violet-500',
      bg:    'bg-violet-50 dark:bg-violet-950/30',
    },
  ]

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquare className="w-4 h-4 text-green-500" />
          WhatsApp — Actividad del día
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {cards.map(card => {
              const Icon = card.icon
              return (
                <div key={card.label} className={cn('rounded-xl p-3 flex flex-col gap-2', card.bg)}>
                  <Icon className={cn('w-4 h-4', card.color)} />
                  <div>
                    <p className="text-xl font-bold tracking-tight">{card.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{card.label}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
})
