/**
 * DataTableMobileCardList — renderiza las filas como tarjetas en mobile.
 *
 * Visible solo en viewports < md (768px) vía clases Tailwind.
 * Cada fila del table se transforma en una Card con:
 *   - Las primeras 2 columnas visibles como título/subtítulo
 *   - El resto de columnas como lista de campos
 *   - Row actions visibles directamente (sin hover — en mobile no hay hover)
 *   - Checkbox de selección accesible
 *
 * Para que funcione, las columnas deben tener `meta.mobileLabel` definido:
 *   {
 *     id: 'phone',
 *     meta: { mobileLabel: 'Teléfono' },
 *     ...
 *   }
 */

import { flexRender, type Table } from '@tanstack/react-table'
import { cn } from '@/lib/utils'

interface DataTableMobileCardListProps<TData> {
  table: Table<TData>
  onRowClick?: (row: TData) => void
  /** Columnas que NO se muestran en el cuerpo de la card (ej: 'select', 'actions') */
  hiddenInCard?: string[]
}

export function DataTableMobileCardList<TData>({
  table,
  onRowClick,
  hiddenInCard = ['select', 'actions'],
}: DataTableMobileCardListProps<TData>) {
  const rows = table.getRowModel().rows

  if (rows.length === 0) return null

  return (
    <div className="md:hidden space-y-2 px-4 py-3" role="list" aria-label="Lista de elementos">
      {rows.map((row) => {
        const isSelected = row.getIsSelected()
        const visibleCells = row.getVisibleCells()

        // Separar checkbox / actions / contenido
        const selectCell  = visibleCells.find(c => c.column.id === 'select')
        const actionCells = visibleCells.filter(c => hiddenInCard.includes(c.column.id) && c.column.id !== 'select')
        const bodyCells   = visibleCells.filter(c => !hiddenInCard.includes(c.column.id))

        return (
          <div
            key={row.id}
            role="listitem"
            onClick={() => onRowClick?.(row.original)}
            className={cn(
              'relative flex gap-3 p-3 rounded-xl border border-border bg-card',
              'transition-colors duration-100',
              isSelected ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/40',
              onRowClick && 'cursor-pointer',
            )}
          >
            {/* Checkbox */}
            {selectCell && (
              <div
                className="pt-0.5 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                {flexRender(selectCell.column.columnDef.cell, selectCell.getContext())}
              </div>
            )}

            {/* Contenido de la card */}
            <div className="flex-1 min-w-0 space-y-1.5">
              {bodyCells.map((cell, i) => {
                const label = (cell.column.columnDef.meta as { mobileLabel?: string } | undefined)?.mobileLabel
                  ?? (typeof cell.column.columnDef.header === 'string' ? cell.column.columnDef.header : cell.column.id)

                return (
                  <div
                    key={cell.id}
                    className={cn(
                      'flex items-start gap-2',
                      // Primera columna: destacada como título
                      i === 0 ? 'text-sm font-medium text-foreground' : 'text-xs text-muted-foreground',
                    )}
                  >
                    {i > 0 && (
                      <span className="shrink-0 w-20 text-muted-foreground/70">
                        {label}:
                      </span>
                    )}
                    <span className={cn('flex-1 min-w-0', i === 0 && 'truncate')}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Row actions — visibles directamente en mobile */}
            {actionCells.length > 0 && (
              <div
                className="flex flex-col items-end gap-1 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                {actionCells.map(cell => (
                  <div key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
