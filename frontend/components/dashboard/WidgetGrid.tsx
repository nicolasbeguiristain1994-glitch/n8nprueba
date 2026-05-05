'use client'

import { memo, useCallback, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WIDGET_REGISTRY, type WidgetId } from './types'
import type { CrmDashboardData } from '@/app/api/dashboard/crm/route'

// ── Individual sortable item ────────────────────────────────────────────────
interface SortableWidgetProps {
  id: WidgetId
  span: 1 | 2
  children: React.ReactNode
}

function SortableWidget({ id, span, children }: SortableWidgetProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    gridColumn: span === 2 ? 'span 2' : undefined,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="relative group/widget">
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        aria-label="Arrastrar widget"
        className={cn(
          'absolute top-2 right-2 z-10 p-1 rounded opacity-0 group-hover/widget:opacity-100',
          'transition-opacity cursor-grab active:cursor-grabbing',
          'text-muted-foreground hover:text-foreground hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:opacity-100',
        )}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      {children}
    </div>
  )
}

// ── Props ────────────────────────────────────────────────────────────────────
interface WidgetGridProps {
  visibleWidgets: WidgetId[]
  data: CrmDashboardData | null
  loading: boolean
  onReorder: (ids: WidgetId[]) => void
  onTaskCompleted?: (id: string) => void
}

// ── Lazy-loaded widget renderers ─────────────────────────────────────────────
// (imported at module level to avoid repeated dynamic imports)
import { KPIWidget } from './widgets/KPIWidget'
import { TasksWidget } from './widgets/TasksWidget'
import { RecentActivityWidget } from './widgets/RecentActivityWidget'
import { QuickActionsWidget } from './widgets/QuickActionsWidget'

const FALLBACK_KPI = { contacts: 0, tasks_pending: 0, tasks_overdue: 0 }

export const WidgetGrid = memo(function WidgetGrid({
  visibleWidgets,
  data,
  loading,
  onReorder,
  onTaskCompleted,
}: WidgetGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const oldIdx = visibleWidgets.indexOf(active.id as WidgetId)
    const newIdx = visibleWidgets.indexOf(over.id as WidgetId)
    if (oldIdx === -1 || newIdx === -1) return
    const next = [...visibleWidgets]
    next.splice(oldIdx, 1)
    next.splice(newIdx, 0, active.id as WidgetId)
    onReorder(next)
  }, [visibleWidgets, onReorder])

  const configMap = useMemo(
    () => Object.fromEntries(WIDGET_REGISTRY.map(w => [w.id, w])),
    [],
  )

  function renderWidget(id: WidgetId) {
    switch (id) {
      case 'kpi':
        return <KPIWidget kpis={data?.kpis ?? FALLBACK_KPI} loading={loading} />
      case 'tasks':
        return <TasksWidget tasks={data?.tasks ?? []} loading={loading} onCompleted={onTaskCompleted} />
      case 'recent_activity':
        return <RecentActivityWidget activities={data?.recent_activity ?? []} loading={loading} />
      case 'quick_actions':
        return <QuickActionsWidget />
      default:
        return null
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={visibleWidgets} strategy={rectSortingStrategy}>
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
        >
          {visibleWidgets.map(id => {
            const cfg = configMap[id]
            if (!cfg) return null
            return (
              <SortableWidget key={id} id={id} span={cfg.span}>
                {renderWidget(id)}
              </SortableWidget>
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
})
