/**
 * DataTableRowActions — contenedor de hover actions por fila.
 *
 * Envuelve los botones de acción de una fila y los hace visibles
 * solo cuando el usuario hace hover sobre la fila (pattern de Attio/Linear).
 *
 * Uso en definición de columna:
 *   cell: ({ row }) => (
 *     <DataTableRowActions>
 *       <button onClick={() => deleteRow(row.original.id)}>...</button>
 *     </DataTableRowActions>
 *   )
 */

import { cn } from '@/lib/utils'

interface DataTableRowActionsProps {
  children: React.ReactNode
  className?: string
}

export function DataTableRowActions({ children, className }: DataTableRowActionsProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 justify-end',
        // Ocultar por defecto, visible en hover del <tr> padre.
        // El <tr> padre debe tener el grupo "group/row" para que funcione.
        'opacity-0 group-hover/row:opacity-100 transition-opacity duration-100',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Botón de acción individual dentro de DataTableRowActions */
export function DataTableActionButton({
  onClick,
  icon: Icon,
  label,
  variant = 'default',
}: {
  onClick: (e: React.MouseEvent) => void
  icon: React.ElementType
  label: string
  variant?: 'default' | 'destructive'
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      title={label}
      aria-label={label}
      className={cn(
        'p-1.5 rounded-md transition-colors',
        variant === 'destructive'
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon size={13} aria-hidden="true" />
    </button>
  )
}
