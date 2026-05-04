'use client'

/**
 * DataTable<TData> — componente principal del sistema de tablas.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * MODOS DE RENDERIZADO:
 *   - Paginated (default): paginación client-side o manual (server-side).
 *     Ideal para APIs que devuelven páginas (contacts, campaigns, etc.).
 *   - Virtual (virtual={true}): usa @tanstack/react-virtual para renderizar
 *     todas las filas con un scroll container virtualizado (sin paginación).
 *     Ideal para datasets client-side de 5000+ filas con alto rendimiento.
 *
 *   Nota: Virtualización y paginación son mutuamente excluyentes.
 *   Para server-side: usar manualPagination=true + virtual=false.
 *
 * RESPONSIVE:
 *   - Desktop (≥ md): tabla HTML estándar con sticky header.
 *   - Mobile (< md): DataTableMobileCardList — cada fila es una Card.
 *
 * ACCESIBILIDAD:
 *   - role="grid" en la tabla con aria-rowcount y aria-colcount.
 *   - Sticky header con scope="col" en cada <th>.
 *   - Filas con aria-selected según selección.
 *   - Focus visible en todos los controles interactivos.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useRef } from 'react'
import { flexRender } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { useDataTable } from './useDataTable'
import { DataTableToolbar } from './DataTableToolbar'
import { DataTablePagination } from './DataTablePagination'
import { DataTableSkeleton } from './DataTableSkeleton'
import { DataTableEmptyState } from './DataTableEmptyState'
import { DataTableMobileCardList } from './DataTableMobileCardList'
import type { DataTableProps } from './types'
import { DENSITY_ROW_CLASS } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Columna de selección — se inyecta automáticamente cuando hay rowSelection
// ─────────────────────────────────────────────────────────────────────────────

function buildSelectionColumn<TData>() {
  return {
    id: 'select',
    header: ({ table }: { table: import('@tanstack/react-table').Table<TData> }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        // indeterminate es prop nativo de @base-ui/react Checkbox
        indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(v)}
        aria-label="Seleccionar todas las filas de esta página"
        onClick={(e) => e.stopPropagation()}
      />
    ),
    cell: ({ row }: { row: import('@tanstack/react-table').Row<TData> }) => (
      <Checkbox
        checked={row.getIsSelected()}
        disabled={!row.getCanSelect()}
        onCheckedChange={(v) => row.toggleSelected(v)}
        aria-label="Seleccionar fila"
        onClick={(e) => e.stopPropagation()}
      />
    ),
    enableSorting: false,
    enableHiding:  false,
    size: 40,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DataTable — componente principal
// ─────────────────────────────────────────────────────────────────────────────

export function DataTable<TData>({
  data,
  columns: externalColumns,
  loading = false,
  toolbar,
  bulkActions,
  rowActions,
  emptyState,
  onRowClick,
  storageKey = 'datatable',
  virtual = false,
  totalRows,
  // Paginación
  manualPagination,
  pageCount,
  pagination: externalPagination,
  onPaginationChange,
  // Sorting
  manualSorting,
  sorting: externalSorting,
  onSortingChange,
  // Selección
  rowSelection: externalRowSelection,
  onRowSelectionChange,
  getRowId,
}: DataTableProps<TData> & { totalRows?: number }) {

  // Inyectar columna de selección si el parent provee rowSelection
  const columns = externalRowSelection !== undefined || onRowSelectionChange !== undefined
    ? [buildSelectionColumn<TData>() as import('@tanstack/react-table').ColumnDef<TData, unknown>, ...externalColumns]
    : externalColumns

  const { table, density, setDensity } = useDataTable({
    data,
    columns,
    manualPagination,
    pageCount,
    pagination: externalPagination,
    onPaginationChange,
    manualSorting,
    sorting: externalSorting,
    onSortingChange,
    rowSelection: externalRowSelection,
    onRowSelectionChange,
    getRowId,
    storageKey,
    virtual,
  })

  // Referencia para el scroll container del modo virtual
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const rows = table.getRowModel().rows

  // ── Virtualización ──────────────────────────────────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => density === 'compact' ? 36 : density === 'comfortable' ? 56 : 44,
    overscan: 10,
    enabled: virtual,
  })
  const virtualRows = virtual ? rowVirtualizer.getVirtualItems() : null

  // IDs de filas seleccionadas (para bulk actions)
  const selectedIds = Object.keys(table.getState().rowSelection)
  const selectedCount = selectedIds.length

  const rowDensityClass = DENSITY_ROW_CLASS[density]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden">

      {/* ── Toolbar interno (density + col visibility + slot externo) ── */}
      <DataTableToolbar
        table={table}
        density={density}
        onDensityChange={setDensity}
      >
        {toolbar}
      </DataTableToolbar>

      {/* ── Tabla desktop ── */}
      <div
        ref={virtual ? scrollContainerRef : undefined}
        className={cn(
          'hidden md:block overflow-auto',
          virtual && 'max-h-[600px]',
        )}
      >
        <table
          role="grid"
          aria-rowcount={totalRows ?? rows.length}
          aria-colcount={table.getVisibleLeafColumns().length}
          className="w-full text-sm"
        >
          {/* Sticky header */}
          <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur-sm border-b border-border">
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {hg.headers.map(header => (
                  <th
                    key={header.id}
                    scope="col"
                    colSpan={header.colSpan}
                    style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                    className="px-4 py-2.5 text-left font-medium whitespace-nowrap"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>

          <tbody
            style={virtual ? { height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' } : undefined}
          >
            {/* Loading skeleton */}
            {loading && (
              <DataTableSkeleton
                rows={8}
                cols={table.getVisibleLeafColumns().length}
              />
            )}

            {/* Sin datos */}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={table.getVisibleLeafColumns().length}>
                  {emptyState ?? <DataTableEmptyState />}
                </td>
              </tr>
            )}

            {/* Filas normales (paginated) */}
            {!loading && !virtual && rows.map(row => (
              <tr
                key={row.id}
                role="row"
                aria-selected={row.getIsSelected()}
                data-state={row.getIsSelected() ? 'selected' : undefined}
                onClick={() => onRowClick?.(row.original)}
                className={cn(
                  'group/row border-b border-border last:border-0',
                  'transition-colors duration-100',
                  row.getIsSelected()
                    ? 'bg-primary/5'
                    : 'hover:bg-muted/40',
                  onRowClick && 'cursor-pointer',
                )}
              >
                {row.getVisibleCells().map(cell => (
                  <td
                    key={cell.id}
                    className={cn('px-4', rowDensityClass)}
                  >
                    {/* Row actions: columna especial con hover invisible */}
                    {cell.column.id === 'actions' && rowActions
                      ? rowActions(row.original)
                      : flexRender(cell.column.columnDef.cell, cell.getContext())
                    }
                  </td>
                ))}
              </tr>
            ))}

            {/* Filas virtualizadas */}
            {!loading && virtual && virtualRows && virtualRows.map(virtualRow => {
              const row = rows[virtualRow.index]
              return (
                <tr
                  key={row.id}
                  role="row"
                  aria-selected={row.getIsSelected()}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  onClick={() => onRowClick?.(row.original)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={cn(
                    'group/row border-b border-border flex',
                    'transition-colors duration-100',
                    row.getIsSelected() ? 'bg-primary/5' : 'hover:bg-muted/40',
                    onRowClick && 'cursor-pointer',
                  )}
                >
                  {row.getVisibleCells().map(cell => (
                    <td
                      key={cell.id}
                      className={cn('px-4 flex-1', rowDensityClass)}
                    >
                      {cell.column.id === 'actions' && rowActions
                        ? rowActions(row.original)
                        : flexRender(cell.column.columnDef.cell, cell.getContext())
                      }
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Mobile cards ── */}
      {!loading && (
        <DataTableMobileCardList
          table={table}
          onRowClick={onRowClick}
        />
      )}

      {/* ── Paginación ── */}
      {!virtual && (
        <DataTablePagination table={table} totalRows={totalRows} />
      )}

      {/* ── Bulk actions flotante ── */}
      {bulkActions && selectedCount > 0 && (
        <>{bulkActions(selectedIds)}</>
      )}
    </div>
  )
}
