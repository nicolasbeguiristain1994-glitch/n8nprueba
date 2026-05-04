'use client'

/**
 * DataTableBulkActions — barra flotante de acciones sobre selección múltiple.
 *
 * Aparece desde abajo (slide-up) cuando selectedCount > 0.
 * Se posiciona sobre la MobileNav (z-40 + mb para no tapar el bottom nav).
 * El parent pasa los botones de acción como children.
 *
 * Uso:
 *   <DataTableBulkActions selectedCount={5} onClearSelection={fn}>
 *     <Button onClick={deleteSelected}>Eliminar</Button>
 *   </DataTableBulkActions>
 */

import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface DataTableBulkActionsProps {
  selectedCount: number
  onClearSelection: () => void
  children: React.ReactNode
  className?: string
}

export function DataTableBulkActions({
  selectedCount,
  onClearSelection,
  children,
  className,
}: DataTableBulkActionsProps) {
  if (selectedCount === 0) return null

  return (
    <div
      role="toolbar"
      aria-label={`Acciones para ${selectedCount} elementos seleccionados`}
      className={cn(
        // Posición: flotante en el bottom de la pantalla
        'fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-40',
        // Panel visual
        'flex items-center gap-2 px-4 py-2.5',
        'bg-popover border border-border rounded-xl shadow-xl',
        // Animación slide-up
        'animate-in slide-in-from-bottom-4 fade-in duration-200',
        className,
      )}
    >
      {/* Contador */}
      <span className="text-sm font-medium text-foreground whitespace-nowrap mr-1">
        <span className="text-primary font-semibold tabular-nums">{selectedCount}</span>
        {' '}seleccionados
      </span>

      <div className="w-px h-5 bg-border mx-1" aria-hidden="true" />

      {/* Acciones externas */}
      {children}

      {/* Limpiar selección */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 ml-1 text-muted-foreground hover:text-foreground"
        onClick={onClearSelection}
        aria-label="Limpiar selección"
      >
        <X size={14} />
      </Button>
    </div>
  )
}
