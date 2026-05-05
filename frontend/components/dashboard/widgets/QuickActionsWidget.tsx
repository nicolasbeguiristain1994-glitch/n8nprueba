'use client'

import { memo } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Zap, UserPlus, Send, CheckSquare, BarChart2, MessageSquare,
} from 'lucide-react'

const ACTIONS = [
  { label: 'Nuevo contacto',   icon: UserPlus,    href: '/contacts',       color: 'text-blue-500'    },
  { label: 'Nueva campaña',    icon: Send,        href: '/campaigns',      color: 'text-violet-500'  },
  { label: 'Nueva tarea',      icon: CheckSquare, href: '/tareas',         color: 'text-teal-500'    },
  { label: 'Estadísticas',     icon: BarChart2,   href: '/estadisticas',   color: 'text-amber-500'   },
  { label: 'Conversaciones',   icon: MessageSquare, href: '/conversations', color: 'text-rose-500'   },
]

export const QuickActionsWidget = memo(function QuickActionsWidget() {
  const router = useRouter()

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-500" />
          Acciones rápidas
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2">
          {ACTIONS.map(action => {
            const Icon = action.icon
            return (
              <Button
                key={action.label}
                variant="outline"
                size="sm"
                onClick={() => router.push(action.href)}
                className="justify-start gap-2 h-9"
                aria-label={action.label}
              >
                <Icon className={`w-3.5 h-3.5 shrink-0 ${action.color}`} />
                <span className="truncate text-xs">{action.label}</span>
              </Button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
})
