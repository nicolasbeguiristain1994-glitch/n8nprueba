import { cn } from '@/lib/utils'
import { KANBAN_COLUMNS } from './types'

interface KanbanSkeletonProps {
  /** Número de cards skeleton por columna */
  cardsPerColumn?: number
}

/** Skeleton de una card individual */
function CardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg px-3 py-3 space-y-2.5 animate-pulse',
        className,
      )}
      aria-hidden="true"
    >
      {/* Title — ancho variable para que no parezcan idénticas */}
      <div className="h-3.5 bg-muted rounded-md" />
      <div className="h-3 bg-muted rounded-md w-3/4" />

      {/* Amount pill */}
      <div className="h-3 bg-muted/60 rounded-full w-1/3" />

      {/* Meta chips */}
      <div className="flex gap-2 pt-0.5">
        <div className="h-2.5 bg-muted/50 rounded-full w-16" />
        <div className="h-2.5 bg-muted/50 rounded-full w-12" />
      </div>
    </div>
  )
}

/** Skeleton de una columna completa */
function ColumnSkeleton({
  config,
  cardsPerColumn,
}: {
  config: (typeof KANBAN_COLUMNS)[number]
  cardsPerColumn: number
}) {
  return (
    <div className="flex flex-col w-72 shrink-0 snap-start" aria-hidden="true">
      {/* Header */}
      <div
        className={cn(
          'rounded-t-lg border border-b-0 border-border bg-muted/50 px-3 py-2.5',
          'border-t-[3px]',
          config.headerClass,
          'animate-pulse',
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full shrink-0', config.color)} />
          <span className="text-sm font-semibold text-foreground">{config.label}</span>
          {/* Count badge skeleton */}
          <div className="h-4 w-6 bg-muted rounded-full" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 rounded-b-lg border border-border bg-muted/20 p-2 space-y-2 min-h-[120px]">
        {Array.from({ length: cardsPerColumn }).map((_, i) => (
          <CardSkeleton
            key={i}
            // Variar ligeramente el ancho del segundo bloque de título
            className={i % 2 === 0 ? '[&>div:nth-child(2)]:w-2/3' : '[&>div:nth-child(2)]:w-4/5'}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * KanbanSkeleton — reemplaza el KanbanBoard mientras se cargan los datos.
 *
 * Uso en `app/(protected)/pipeline/loading.tsx`:
 *   <KanbanSkeleton />
 *
 * O condicionalmente dentro del board:
 *   {loading ? <KanbanSkeleton /> : <KanbanBoard ... />}
 */
export function KanbanSkeleton({ cardsPerColumn = 3 }: KanbanSkeletonProps) {
  return (
    <div
      className={cn(
        'flex gap-4 overflow-x-auto pb-4',
        // Mobile: scroll snapping horizontal
        'snap-x snap-mandatory',
      )}
      aria-label="Cargando pipeline..."
      role="status"
    >
      {KANBAN_COLUMNS.map(col => (
        <ColumnSkeleton key={col.id} config={col} cardsPerColumn={cardsPerColumn} />
      ))}
    </div>
  )
}
