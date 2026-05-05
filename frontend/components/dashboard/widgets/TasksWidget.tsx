'use client'

import { memo, useCallback, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckSquare, Clock, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PendingTask } from '@/app/api/dashboard/crm/route'

interface Props {
  tasks: PendingTask[]
  loading?: boolean
  onCompleted?: (id: string) => void
}

const PRIORITY_STYLE: Record<string, string> = {
  alta:  'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  media: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  baja:  'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

const PRIORITY_DOT: Record<string, string> = {
  alta: 'bg-rose-500', media: 'bg-amber-500', baja: 'bg-slate-400',
}

function isOverdue(due: string | null) {
  return due != null && new Date(due) < new Date()
}

function fmtDate(due: string | null) {
  if (!due) return null
  const d = new Date(due)
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
}

export const TasksWidget = memo(function TasksWidget({ tasks, loading, onCompleted }: Props) {
  const [completing, setCompleting] = useState<Set<string>>(new Set())

  const complete = useCallback(async (id: string) => {
    setCompleting(prev => new Set(prev).add(id))
    try {
      await fetch(`/api/tasks/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completada' }),
      })
      onCompleted?.(id)
    } finally {
      setCompleting(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }, [onCompleted])

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckSquare className="w-4 h-4 text-teal-500" />
          Tareas pendientes
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <CheckSquare className="w-8 h-8 opacity-30" />
            <p className="text-sm">Sin tareas pendientes</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {tasks.map(task => {
              const overdue = isOverdue(task.due_date)
              const done = completing.has(task.id)
              return (
                <button
                  key={task.id}
                  onClick={() => complete(task.id)}
                  disabled={done}
                  aria-label={`Completar tarea: ${task.title}`}
                  className={cn(
                    'w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors',
                    'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    done && 'opacity-40 pointer-events-none',
                  )}
                >
                  <span className={cn('w-2 h-2 rounded-full shrink-0', PRIORITY_DOT[task.priority] ?? 'bg-gray-400')} />
                  <span className="flex-1 min-w-0">
                    <span className={cn('text-sm block truncate', done && 'line-through text-muted-foreground')}>
                      {task.title}
                    </span>
                    {task.due_date && (
                      <span className={cn('text-xs flex items-center gap-1 mt-0.5',
                        overdue ? 'text-rose-500' : 'text-muted-foreground'
                      )}>
                        {overdue
                          ? <AlertTriangle className="w-3 h-3" />
                          : <Clock className="w-3 h-3" />
                        }
                        {fmtDate(task.due_date)}
                      </span>
                    )}
                  </span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0', PRIORITY_STYLE[task.priority])}>
                    {task.priority}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
})
