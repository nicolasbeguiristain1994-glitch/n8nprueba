/**
 * useDataTable — hook que encapsula la configuración de useReactTable.
 *
 * Decisiones de API:
 *   - Soporta paginación y sorting controlados (server-side) o internos (client-side).
 *   - La visibilidad de columnas y densidad se persisten en localStorage
 *     usando el hook useLocalStorage del proyecto.
 *   - Row selection siempre controlada externamente para que el parent
 *     pueda derivar IDs seleccionados para bulk actions.
 */

import { useState, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  type Updater,
} from '@tanstack/react-table'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type {
  DataTableProps,
  Density,
  PaginationState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from './types'

export function useDataTable<TData>({
  data,
  columns,
  manualPagination = false,
  pageCount,
  pagination: externalPagination,
  onPaginationChange,
  manualSorting = false,
  sorting: externalSorting,
  onSortingChange,
  rowSelection: externalRowSelection,
  onRowSelectionChange,
  getRowId,
  storageKey = 'datatable',
  virtual = false,
}: Pick<
  DataTableProps<TData>,
  | 'data'
  | 'columns'
  | 'manualPagination'
  | 'pageCount'
  | 'pagination'
  | 'onPaginationChange'
  | 'manualSorting'
  | 'sorting'
  | 'onSortingChange'
  | 'rowSelection'
  | 'onRowSelectionChange'
  | 'getRowId'
  | 'storageKey'
  | 'virtual'
>) {
  // ── Estado persistido ────────────────────────────────────────────────────
  const [density, setDensity] = useLocalStorage<Density>(
    `${storageKey}:density`,
    'normal',
  )
  const [columnVisibility, setColumnVisibility] = useLocalStorage<VisibilityState>(
    `${storageKey}:cols`,
    {},
  )

  // ── Estado interno (cuando no se controla externamente) ──────────────────
  const [internalPagination, setInternalPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  })
  const [internalSorting, setInternalSorting] = useState<SortingState>([])
  const [internalRowSelection, setInternalRowSelection] = useState<RowSelectionState>({})

  const paginationState  = externalPagination  ?? internalPagination
  const sortingState     = externalSorting     ?? internalSorting
  const rowSelectionState = externalRowSelection ?? internalRowSelection

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handlePaginationChange = useCallback(
    (updater: Updater<PaginationState>) => {
      const next = typeof updater === 'function' ? updater(paginationState) : updater
      onPaginationChange?.(next)
      if (!externalPagination) setInternalPagination(next)
    },
    [paginationState, onPaginationChange, externalPagination],
  )

  const handleSortingChange = useCallback(
    (updater: Updater<SortingState>) => {
      const next = typeof updater === 'function' ? updater(sortingState) : updater
      onSortingChange?.(next)
      if (!externalSorting) setInternalSorting(next)
    },
    [sortingState, onSortingChange, externalSorting],
  )

  const handleRowSelectionChange = useCallback(
    (updater: Updater<RowSelectionState>) => {
      const next = typeof updater === 'function' ? updater(rowSelectionState) : updater
      onRowSelectionChange?.(next)
      if (!externalRowSelection) setInternalRowSelection(next)
    },
    [rowSelectionState, onRowSelectionChange, externalRowSelection],
  )

  // ── Instancia de TanStack Table ──────────────────────────────────────────
  const table = useReactTable<TData>({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // En modo virtual no necesitamos pagination model (se muestran todas las filas)
    ...(!virtual && { getPaginationRowModel: getPaginationRowModel() }),
    // Sorting client-side solo si no es manual
    ...(!manualSorting && { getSortedRowModel: getSortedRowModel() }),
    // Filter client-side siempre disponible (para global filter)
    getFilteredRowModel: getFilteredRowModel(),
    onPaginationChange: handlePaginationChange,
    onSortingChange:    handleSortingChange,
    onRowSelectionChange: handleRowSelectionChange,
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      pagination:       paginationState,
      sorting:          sortingState,
      rowSelection:     rowSelectionState,
      columnVisibility,
    },
    manualPagination,
    pageCount:    manualPagination ? (pageCount ?? -1) : undefined,
    manualSorting,
    enableRowSelection: true,
    getRowId,
  })

  return { table, density, setDensity, columnVisibility }
}
