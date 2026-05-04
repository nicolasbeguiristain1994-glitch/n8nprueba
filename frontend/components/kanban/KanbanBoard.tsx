'use client'

import React, { useState, useCallback } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core'
import { KanbanColumn } from './KanbanColumn'
import { KanbanCard } from './KanbanCard'
import { KanbanDealForm } from './KanbanDealForm'
import { useKanban } from './useKanban'
import { KANBAN_COLUMNS } from './types'
import { cn } from '@/lib/utils'
import type { Deal, DealsByStage, DealStage } from './types'

interface KanbanBoardProps {
  initialDeals: DealsByStage
}

export function KanbanBoard({ initialDeals }: KanbanBoardProps) {
  const {
    deals,
    activeId,
    activeDeal,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    addDeal,
    removeDeal,
  } = useKanban({ initialDeals })

  const [formStage, setFormStage] = useState<DealStage | null>(null)
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null)
  // Mobile: stage activo en vista tab
  const [mobileStage, setMobileStage] = useState<DealStage>('calificado')

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  )

  const openAddForm = useCallback((stage: string) => {
    setFormStage(stage as DealStage)
    setEditingDeal(null)
  }, [])

  const openEditForm = useCallback((deal: Deal) => {
    setEditingDeal(deal)
    setFormStage(deal.stage)
  }, [])

  const handleDelete = useCallback(async (id: number) => {
    if (!confirm('¿Eliminar este deal?')) return
    removeDeal(id)
    await fetch(`/api/deals/${id}`, { method: 'DELETE' })
  }, [removeDeal])

  const handleFormSave = useCallback((deal: Deal) => {
    if (editingDeal) {
      // Recargar página para reflejar cambios (simple approach)
      window.location.reload()
    } else {
      addDeal(deal)
    }
    setFormStage(null)
    setEditingDeal(null)
  }, [editingDeal, addDeal])

  const activeMobileConfig = KANBAN_COLUMNS.find(c => c.id === mobileStage)!

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {/* ── Mobile: stage tabs + single column ────────────────────────── */}
        <div className="md:hidden flex flex-col gap-3">
          {/* Stage tabs — scrollables en horizontal */}
          <div
            className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none"
            role="tablist"
            aria-label="Etapas del pipeline"
          >
            {KANBAN_COLUMNS.map(col => (
              <button
                key={col.id}
                role="tab"
                aria-selected={mobileStage === col.id}
                onClick={() => setMobileStage(col.id)}
                className={cn(
                  'flex items-center gap-1.5 shrink-0 px-3 h-8 rounded-full text-xs font-medium',
                  'border transition-colors whitespace-nowrap',
                  mobileStage === col.id
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-background text-muted-foreground border-border hover:border-foreground/30',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full', col.color)} />
                {col.label}
                <span className="opacity-60">{deals[col.id].length}</span>
              </button>
            ))}
          </div>

          {/* Columna activa — full width en mobile */}
          <div className="w-full" role="tabpanel" aria-label={activeMobileConfig.label}>
            <KanbanColumn
              config={activeMobileConfig}
              deals={deals[mobileStage]}
              onAddDeal={openAddForm}
              onEditDeal={openEditForm}
              onDeleteDeal={handleDelete}
              fullWidth
            />
          </div>
        </div>

        {/* ── Desktop: scroll horizontal con todas las columnas ─────────── */}
        <div
          className={cn(
            'hidden md:flex gap-4 overflow-x-auto pb-4 items-start',
            'min-h-[calc(100vh-180px)]',
            // scroll snap suave
            'snap-x snap-mandatory scroll-smooth',
          )}
        >
          {KANBAN_COLUMNS.map(col => (
            <KanbanColumn
              key={col.id}
              config={col}
              deals={deals[col.id]}
              onAddDeal={openAddForm}
              onEditDeal={openEditForm}
              onDeleteDeal={handleDelete}
            />
          ))}
        </div>

        {/* DragOverlay — card clone while dragging */}
        <DragOverlay dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
          {activeDeal ? (
            <KanbanCard deal={activeDeal} isDragging />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Deal form modal */}
      {formStage && (
        <KanbanDealForm
          stage={formStage}
          deal={editingDeal ?? undefined}
          onSave={handleFormSave}
          onClose={() => { setFormStage(null); setEditingDeal(null) }}
        />
      )}
    </>
  )
}
