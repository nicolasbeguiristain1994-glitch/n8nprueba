'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PipelineStage } from '@/app/api/dashboard/crm/route'

interface Props {
  pipeline: PipelineStage[]
  loading?: boolean
}

const STAGE_COLORS: Record<string, string> = {
  calificado:  'bg-blue-400',
  propuesta:   'bg-violet-400',
  negociacion: 'bg-amber-400',
  cierre:      'bg-orange-400',
}

const BAR_COLORS: Record<string, string> = {
  calificado:  'bg-blue-400',
  propuesta:   'bg-violet-400',
  negociacion: 'bg-amber-400',
  cierre:      'bg-orange-400',
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

export const PipelineSummaryWidget = memo(function PipelineSummaryWidget({ pipeline, loading }: Props) {
  const maxCount = Math.max(...pipeline.map(p => p.count), 1)

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-violet-500" />
          Pipeline activo
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : pipeline.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
            Sin deals activos
          </div>
        ) : (
          <div className="space-y-3">
            {pipeline.map(stage => {
              const pct = Math.max((stage.count / maxCount) * 100, 4)
              return (
                <div key={stage.stage}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={cn('w-2 h-2 rounded-full', STAGE_COLORS[stage.stage] ?? 'bg-gray-400')} />
                      <span className="text-sm font-medium">{stage.label}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{stage.count} deals</span>
                      <span className="text-xs font-medium w-16 text-right">{fmt(stage.value)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all', BAR_COLORS[stage.stage] ?? 'bg-gray-400')}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
            <div className="pt-2 border-t mt-4">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Total en pipeline</span>
                <span className="font-medium text-foreground">
                  {fmt(pipeline.reduce((s, p) => s + p.value, 0))}
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
