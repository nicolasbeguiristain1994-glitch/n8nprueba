/**
 * Barrel export del sistema DataTable.
 *
 * Importación recomendada:
 *   import { DataTable, DataTableColumnHeader, DataTableBulkActions } from '@/components/data-display/DataTable'
 *   import type { ColumnDef, RowSelectionState, PaginationState } from '@/components/data-display/DataTable'
 */

export { DataTable }                  from './DataTable'
export { EditableCell }               from './EditableCell'
export type { EditableCellProps, EditableCellOption } from './EditableCell'
export { DataTableToolbar }           from './DataTableToolbar'
export { DataTablePagination }        from './DataTablePagination'
export { DataTableColumnHeader }      from './DataTableColumnHeader'
export { DataTableRowActions, DataTableActionButton } from './DataTableRowActions'
export { DataTableBulkActions }       from './DataTableBulkActions'
export { DataTableEmptyState }        from './DataTableEmptyState'
export { DataTableSkeleton }          from './DataTableSkeleton'
export { DataTableMobileCardList }    from './DataTableMobileCardList'
export { useDataTable }               from './useDataTable'

// Re-export tipos
export type {
  DataTableProps,
  Density,
  ColumnDef,
  PaginationState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from './types'
