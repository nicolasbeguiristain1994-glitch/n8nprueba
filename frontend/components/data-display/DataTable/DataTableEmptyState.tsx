/**
 * DataTableEmptyState — estado vacío genérico.
 *
 * Se usa cuando la tabla no tiene filas (sin datos o sin resultados de búsqueda).
 * Se puede reemplazar pasando `emptyState` prop al DataTable.
 */

import { SearchX } from 'lucide-react'

interface DataTableEmptyStateProps {
  message?: string
  description?: string
  icon?: React.ElementType
}

export function DataTableEmptyState({
  message = 'Sin resultados',
  description = 'Ajustá los filtros o agregá nuevos registros.',
  icon: Icon = SearchX,
}: DataTableEmptyStateProps) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon size={20} className="text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-foreground">{message}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs">{description}</p>
    </div>
  )
}
