'use client'

import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { Table } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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

  const [inputValue, setInputValue] = useState(String(pageIndex + 1))

  // Sincronizar cuando la página cambia externamente (filtros, reset, etc.)
  useEffect(() => {
    setInputValue(String(pageIndex + 1))
  }, [pageIndex])

  // No mostrar si solo hay una página
  if (pageCount <= 1 && !table.getCanNextPage() && !table.getCanPreviousPage()) {
    return null
  }

  const from = pageIndex * pageSize + 1
  const to   = Math.min((pageIndex + 1) * pageSize, totalRows ?? (pageIndex + 1) * pageSize)

  const goToPage = () => {
    const parsed = parseInt(inputValue, 10)
    if (!isNaN(parsed) && parsed >= 1 && parsed <= pageCount) {
      table.setPageIndex(parsed - 1)
    } else {
      setInputValue(String(pageIndex + 1))
    }
  }

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
      <div className="flex items-center gap-2" role="group" aria-label="Controles de página">
        {/* Ir a página */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Ir a:</span>
          <Input
            type="number"
            min={1}
            max={pageCount}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onBlur={goToPage}
            onKeyDown={e => { if (e.key === 'Enter') goToPage() }}
            className="h-7 w-16 text-xs text-center px-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            aria-label="Número de página"
          />
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">de {pageCount}</span>
        </div>

        <div className="flex items-center gap-1">
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
    </div>
  )
}
