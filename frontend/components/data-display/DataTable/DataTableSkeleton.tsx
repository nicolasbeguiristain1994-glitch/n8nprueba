/**
 * DataTableSkeleton — filas de carga animadas.
 *
 * Se renderiza dentro del <tbody> cuando loading=true.
 * El número de columnas y filas es configurable para ajustarse a cada entidad.
 */

import { cn } from '@/lib/utils'

interface DataTableSkeletonProps {
  /** Número de filas skeleton a mostrar */
  rows?: number
  /** Número de columnas (incluida la de selección) */
  cols?: number
}

export function DataTableSkeleton({ rows = 8, cols = 6 }: DataTableSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <tr
          key={rowIdx}
          className="border-b border-border animate-pulse"
          aria-hidden="true"
        >
          {Array.from({ length: cols }).map((_, colIdx) => (
            <td key={colIdx} className="px-4 py-3">
              <div
                className={cn(
                  'h-4 rounded bg-muted',
                  // Variaciones de ancho para que parezca contenido real
                  colIdx === 0 && 'w-4',          // checkbox
                  colIdx === 1 && 'w-28',          // campo principal (ej: teléfono)
                  colIdx === 2 && 'w-36',          // segundo campo (ej: nombre)
                  colIdx >= 3 && colIdx < cols - 1 && 'w-20', // campos medios
                  colIdx === cols - 1 && 'w-6',    // acciones
                )}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
