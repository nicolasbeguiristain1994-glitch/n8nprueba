'use client'

import React, { memo } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { KanbanCard } from './KanbanCard'
import type { Deal, KanbanColumnConfig } from './types'

interface KanbanColumnProps {
  config: KanbanColumnConfig
  deals: Deal[]
  isOver?: boolean
  /** En mobile, la columna ocupa el 100% del ancho disponible */
  fullWidth?: boolean
  onAddDeal?: (stage: string) => void
  onEditDeal?: (deal: Deal) => void
  onDeleteDeal?: (id: number) => void
}

function totalAmount(deals: Deal[]): number {
  return deals.reduce((sum, d) => sum + (d.amount ?? 0), 0)
}

function formatTotal(amount: number): string {
  if (amount === 0) return ''
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(amount)
}

export const KanbanColumn = memo(function KanbanColumn({
  config,
  deals,
  fullWidth,
  onAddDeal,
  onEditDeal,
  onDeleteDeal,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: config.id })
  const dealIds = deals.map(d => d.id)
  const total = totalAmount(deals)

  return (
    <div className={cn('flex flex-col shrink-0', fullWidth ? 'w-full' : 'w-72 snap-start')}>
      {/* Column header */}
      <div
        className={cn(
          'rounded-t-lg border border-b-0 border-border bg-muted/50 px-3 py-2.5',
          'border-t-[3px]',
          config.headerClass,
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full shrink-0', config.color)} />
            <span className="text-sm font-semibold text-foreground">{config.label}</span>
            <span className="text-xs text-muted-foreground bg-background rounded-full px-1.5 py-0.5 font-medium">
              {deals.length}
            </span>
          </div>
          {onAddDeal && (
            <button
              onClick={() => onAddDeal(config.id)}
              className="p-1 rounded hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={`Agregar deal en ${config.label}`}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {total > 0 && (
          <p className="text-xs text-muted-foreground mt-1 font-medium">{formatTotal(total)}</p>
        )}
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 rounded-b-lg border border-border bg-muted/20',
          'min-h-[120px] p-2 space-y-2',
          'transition-colors duration-150',
          isOver && 'bg-primary/5 border-primary/30',
        )}
      >
        <SortableContext items={dealIds} strategy={verticalListSortingStrategy}>
          {deals.map(deal => (
            <KanbanCard
              key={deal.id}
              deal={deal}
              onEdit={onEditDeal}
              onDelete={onDeleteDeal}
            />
          ))}
        </SortableContext>

        {deals.length === 0 && (
          <div className={cn(
            'flex items-center justify-center h-20 rounded-md border-2 border-dashed',
            'border-border/40 text-xs text-muted-foreground/50',
            isOver && 'border-primary/40 text-primary/50',
          )}>
            Soltar aquí
          </div>
        )}
      </div>
    </div>
  )
})
