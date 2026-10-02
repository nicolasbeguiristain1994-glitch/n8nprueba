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
import { WIDGET_REGISTRY, type WidgetId, type DateRange } from './types'
import type { DashboardData } from './useDashboard'
import type { Platform } from '@/lib/casino-agents'

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
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className={cn('relative group/widget min-w-0', span === 2 && 'md:col-span-2')}>
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
  data: DashboardData | null
  loading: boolean
  platform: Platform
  agent: string
  dateRange: DateRange
  revision: number
  onReorder: (ids: WidgetId[]) => void
  onTaskCompleted?: (id: string) => void
}

// ── Widget imports ────────────────────────────────────────────────────────────
import { TasksWidget } from './widgets/TasksWidget'
import { QuickActionsWidget } from './widgets/QuickActionsWidget'
import { CasinoKPIWidget } from './widgets/CasinoKPIWidget'
import { AgentesTableWidget } from './widgets/AgentesTableWidget'
import { CajaWidget } from './widgets/CajaWidget'
import { VipsEnRiesgoWidget } from './widgets/VipsEnRiesgoWidget'
import { SegmentosWidget } from './widgets/SegmentosWidget'
import { MensajeriaWidget } from './widgets/MensajeriaWidget'

export const WidgetGrid = memo(function WidgetGrid({
  visibleWidgets,
  data,
  loading,
  platform,
  agent,
  dateRange,
  revision,
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
    const casino = data?.casino ?? null
    const casinoLoading = loading && !casino
    const unavailable = <p className="rounded-xl border p-4 text-sm text-muted-foreground">Datos no disponibles. Reintentá con Refrescar vista.</p>
    switch (id) {
      case 'casino_kpi':
        return <CasinoKPIWidget summary={casino?.summary ?? null} loading={casinoLoading} />
      case 'agentes':
        return <AgentesTableWidget agentes={casino?.agentes ?? null} loading={casinoLoading} platform={platform} agentFilter={agent} dateRange={dateRange} revision={revision} />
      case 'caja':
        return <CajaWidget enabled={!loading} dateRange={dateRange} platform={platform} agent={agent} revision={revision} />
      case 'vips_riesgo':
        if (!loading && !casino) return unavailable
        return <VipsEnRiesgoWidget vips={casino?.vips ?? []} loading={casinoLoading} />
      case 'segmentos':
        if (!loading && !casino) return unavailable
        return <SegmentosWidget segActividad={casino?.seg_actividad ?? []} segMonto={casino?.seg_monto ?? []} loading={casinoLoading} />
      case 'mensajeria':
        if (!loading && !data?.msgs) return unavailable
        return <MensajeriaWidget msgs={data?.msgs ?? null} loading={loading && !data?.msgs} />
      case 'tasks':
        if (!loading && !data?.crmAvailable) return unavailable
        return <TasksWidget tasks={data?.tasks ?? []} loading={loading && !data?.crmAvailable} onCompleted={onTaskCompleted} />
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
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
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
