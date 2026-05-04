'use client'

import React, { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Pencil, Trash2, User, Phone, CalendarDays, DollarSign } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Deal } from './types'

interface KanbanCardProps {
  deal: Deal
  isDragging?: boolean
  onEdit?: (deal: Deal) => void
  onDelete?: (id: number) => void
}

function formatAmount(amount: number | null): string | null {
  if (amount == null) return null
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount)
}

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })
}

export const KanbanCard = memo(function KanbanCard({ deal, isDragging, onEdit, onDelete }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: deal.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const isGhost = isSortableDragging && !isDragging

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative bg-card border border-border rounded-lg shadow-sm',
        'transition-all duration-150',
        isGhost && 'opacity-40 scale-95',
        isDragging && 'shadow-xl ring-2 ring-primary/30 rotate-[1deg]',
      )}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className={cn(
          'absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded',
          'text-muted-foreground/30 hover:text-muted-foreground',
          'opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        aria-label="Arrastrar deal"
      >
        <GripVertical size={14} />
      </button>

      <div className="pl-6 pr-2 py-3 space-y-2">
        {/* Title + actions */}
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug text-foreground line-clamp-2 flex-1">
            {deal.title}
          </p>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {onEdit && (
              <button
                onClick={() => onEdit(deal)}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Editar deal"
              >
                <Pencil size={12} />
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(deal.id)}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                aria-label="Eliminar deal"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Amount */}
        {deal.amount != null && (
          <div className="flex items-center gap-1 text-xs text-emerald-600 font-semibold">
            <DollarSign size={11} />
            {formatAmount(deal.amount)}
          </div>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {deal.contact_name && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <User size={10} />
              {deal.contact_name}
            </span>
          )}
          {deal.contact_phone && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Phone size={10} />
              {deal.contact_phone}
            </span>
          )}
          {deal.close_date && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CalendarDays size={10} />
              {formatDate(deal.close_date)}
            </span>
          )}
        </div>

        {/* Owner badge */}
        {deal.owner_name && (
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center h-5 px-1.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
              {deal.owner_name}
            </span>
          </div>
        )}
      </div>
    </div>
  )
})
