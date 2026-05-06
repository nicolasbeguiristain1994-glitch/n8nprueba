'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Activity, UserPlus, CheckSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RecentActivity } from '@/app/api/dashboard/crm/route'

interface Props {
  activities: RecentActivity[]
  loading?: boolean
}

const TYPE_CONFIG: Record<RecentActivity['type'], { icon: typeof CheckSquare; color: string; bg: string }> = {
  task_completed: { icon: CheckSquare, color: 'text-teal-500',  bg: 'bg-teal-100 dark:bg-teal-950/40'  },
  contact_added:  { icon: UserPlus,    color: 'text-blue-500',  bg: 'bg-blue-100 dark:bg-blue-950/40'  },
}

function relativeTime(ts: string) {
  const diff  = Date.now() - new Date(ts).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'ahora'
  if (mins < 60)  return `${mins}m`
  if (hours < 24) return `${hours}h`
  return `${days}d`
}

export const RecentActivityWidget = memo(function RecentActivityWidget({ activities, loading }: Props) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-500" />
          Actividad reciente
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-muted animate-pulse rounded w-3/4" />
                  <div className="h-2.5 bg-muted animate-pulse rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : activities.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <Activity className="w-8 h-8 opacity-30" />
            <p className="text-sm">Sin actividad reciente</p>
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />
            <div className="space-y-4">
              {activities.map((act, i) => {
                const cfg  = TYPE_CONFIG[act.type]
                const Icon = cfg.icon
                return (
                  <div key={i} className="flex gap-3 relative">
                    <div className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10', cfg.bg)}>
                      <Icon className={cn('w-3.5 h-3.5', cfg.color)} />
                    </div>
                    <div className="flex-1 min-w-0 pt-1">
                      <p className="text-sm leading-snug truncate">{act.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{act.sub}</p>
                    </div>
                    <span className="text-[11px] text-muted-foreground shrink-0 pt-1 tabular-nums">
                      {relativeTime(act.created_at)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
