/**
 * DataTablePagination — controles de paginación.
 *
 * Muestra: ← Anterior · Pág. X de Y · Siguiente →
 * Compatible con paginación manual (server-side) y client-side.
 */

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { Table } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'

interface DataTablePaginationProps<TData> {
  table: Table<TData>
  /** Total de filas (para mostrar "X de N resultados") */
  totalRows?: number
}

export function DataTablePagination<TData>({
  table,
  totalRows,
}: DataTablePaginationProps<TData>) {
  const { pageIndex, pageSize } = table.getState().pagination
  const pageCount = table.getPageCount()

  // No mostrar si solo hay una página
  if (pageCount <= 1 && !table.getCanNextPage() && !table.getCanPreviousPage()) {
    return null
  }

  const from = pageIndex * pageSize + 1
  const to   = Math.min((pageIndex + 1) * pageSize, totalRows ?? (pageIndex + 1) * pageSize)

  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-t border-border"
      aria-label="Paginación"
    >
      {/* Info de rango */}
      <p className="text-xs text-muted-foreground tabular-nums">
        {totalRows !== undefined
          ? `${from.toLocaleString('es-AR')}–${to.toLocaleString('es-AR')} de ${totalRows.toLocaleString('es-AR')}`
          : `Página ${pageIndex + 1} de ${pageCount}`}
      </p>

      {/* Controles */}
      <div className="flex items-center gap-1" role="group" aria-label="Controles de página">
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => table.setPageIndex(0)}
          disabled={!table.getCanPreviousPage()}
          aria-label="Primera página"
        >
          <ChevronsLeft size={13} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          aria-label="Página anterior"
        >
          <ChevronLeft size={13} />
        </Button>

        <span className="text-xs text-foreground font-medium px-2 tabular-nums">
          {pageIndex + 1} / {pageCount}
        </span>

        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          aria-label="Página siguiente"
        >
          <ChevronRight size={13} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => table.setPageIndex(pageCount - 1)}
          disabled={!table.getCanNextPage()}
          aria-label="Última página"
        >
          <ChevronsRight size={13} />
        </Button>
      </div>
    </div>
  )
}
