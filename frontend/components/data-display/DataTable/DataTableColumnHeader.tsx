/**
 * DataTableColumnHeader — header de columna con indicador de sorting.
 *
 * Muestra ArrowUpDown cuando no está ordenada, ArrowUp/ArrowDown según la
 * dirección activa. El botón es invisible y no ocupa espacio cuando la columna
 * no tiene sorting habilitado.
 */

import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import type { Column } from '@tanstack/react-table'
import { cn } from '@/lib/utils'

interface DataTableColumnHeaderProps<TData, TValue> {
  column: Column<TData, TValue>
  title: string
  className?: string
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <span className={cn('text-xs font-medium text-muted-foreground', className)}>{title}</span>
  }

  const sorted = column.getIsSorted()

  return (
    <button
      onClick={() => column.toggleSorting(sorted === 'asc')}
      className={cn(
        'flex items-center gap-1.5 text-xs font-medium text-muted-foreground',
        'hover:text-foreground transition-colors group -ml-1 px-1 py-0.5 rounded',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
      aria-label={
        sorted === 'asc'
          ? `${title} — ordenado ascendente, click para descendente`
          : sorted === 'desc'
          ? `${title} — ordenado descendente, click para quitar orden`
          : `${title} — sin ordenar, click para ascendente`
      }
    >
      <span>{title}</span>
      <span className="opacity-40 group-hover:opacity-100 transition-opacity" aria-hidden="true">
        {sorted === 'asc'  && <ArrowUp   size={12} className="text-primary" />}
        {sorted === 'desc' && <ArrowDown  size={12} className="text-primary" />}
        {!sorted           && <ArrowUpDown size={12} />}
      </span>
    </button>
  )
}
