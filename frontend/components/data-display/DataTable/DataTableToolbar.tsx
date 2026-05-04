'use client'

/**
 * DataTableToolbar — barra de herramientas interna del DataTable.
 *
 * Contiene:
 *   - Slot izquierdo: contenido externo (búsqueda, filtros — pasado por el parent)
 *   - Slot derecho: density toggle + column visibility toggle (siempre presentes)
 *
 * La densidad y visibilidad se persisten vía useLocalStorage (ya resuelto en useDataTable).
 */

import { useState, useRef, useEffect } from 'react'
import { Columns3, AlignJustify } from 'lucide-react'
import type { Table } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Density } from './types'
import { DENSITY_LABELS } from './types'

const DENSITY_ICONS: Record<Density, React.ReactNode> = {
  compact:     <span className="flex flex-col gap-px" aria-hidden="true"><span className="h-px w-4 bg-current"/><span className="h-px w-4 bg-current"/><span className="h-px w-4 bg-current"/></span>,
  normal:      <span className="flex flex-col gap-0.5" aria-hidden="true"><span className="h-px w-4 bg-current"/><span className="h-px w-4 bg-current"/><span className="h-px w-4 bg-current"/></span>,
  comfortable: <span className="flex flex-col gap-1" aria-hidden="true"><span className="h-px w-4 bg-current"/><span className="h-px w-4 bg-current"/><span className="h-px w-4 bg-current"/></span>,
}

interface DataTableToolbarProps<TData> {
  table: Table<TData>
  density: Density
  onDensityChange: (d: Density) => void
  /** Contenido externo en el lado izquierdo (búsqueda, filtros custom) */
  children?: React.ReactNode
  className?: string
}

export function DataTableToolbar<TData>({
  table,
  density,
  onDensityChange,
  children,
  className,
}: DataTableToolbarProps<TData>) {
  const [densityOpen, setDensityOpen]   = useState(false)
  const [colsOpen,    setColsOpen]       = useState(false)
  const densityRef = useRef<HTMLDivElement>(null)
  const colsRef    = useRef<HTMLDivElement>(null)

  // Cerrar dropdowns al hacer click fuera
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (densityRef.current && !densityRef.current.contains(e.target as Node)) setDensityOpen(false)
      if (colsRef.current    && !colsRef.current.contains(e.target as Node))    setColsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Columnas ocultables (excluye select y actions)
  const hideableColumns = table
    .getAllColumns()
    .filter(col => col.getCanHide())

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-muted/20',
        className,
      )}
    >
      {/* Slot izquierdo */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {children}
      </div>

      {/* Controles derechos */}
      <div className="flex items-center gap-1 shrink-0">

        {/* Density toggle */}
        <div ref={densityRef} className="relative">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => { setDensityOpen(v => !v); setColsOpen(false) }}
            aria-label="Cambiar densidad de filas"
            aria-expanded={densityOpen}
          >
            <AlignJustify size={13} aria-hidden="true" />
            <span className="text-xs hidden sm:inline">{DENSITY_LABELS[density]}</span>
          </Button>

          {densityOpen && (
            <div
              role="menu"
              aria-label="Densidad de filas"
              className={cn(
                'absolute right-0 top-full mt-1 z-30 w-36',
                'bg-popover border border-border rounded-lg shadow-md overflow-hidden',
                'animate-in fade-in-0 zoom-in-95 duration-100 origin-top-right',
              )}
            >
              {(['compact', 'normal', 'comfortable'] as Density[]).map(d => (
                <button
                  key={d}
                  role="menuitem"
                  aria-checked={density === d}
                  onClick={() => { onDensityChange(d); setDensityOpen(false) }}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors text-left',
                    density === d
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-muted',
                  )}
                >
                  {DENSITY_ICONS[d]}
                  {DENSITY_LABELS[d]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Column visibility toggle */}
        {hideableColumns.length > 0 && (
          <div ref={colsRef} className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => { setColsOpen(v => !v); setDensityOpen(false) }}
              aria-label="Columnas visibles"
              aria-expanded={colsOpen}
            >
              <Columns3 size={13} aria-hidden="true" />
              <span className="text-xs hidden sm:inline">Columnas</span>
            </Button>

            {colsOpen && (
              <div
                role="menu"
                aria-label="Visibilidad de columnas"
                className={cn(
                  'absolute right-0 top-full mt-1 z-30 w-44',
                  'bg-popover border border-border rounded-lg shadow-md overflow-hidden py-1',
                  'animate-in fade-in-0 zoom-in-95 duration-100 origin-top-right',
                )}
              >
                {hideableColumns.map(col => {
                  const label = typeof col.columnDef.header === 'string'
                    ? col.columnDef.header
                    : col.id
                  return (
                    <button
                      key={col.id}
                      role="menuitemcheckbox"
                      aria-checked={col.getIsVisible()}
                      onClick={() => col.toggleVisibility()}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left hover:bg-muted transition-colors"
                    >
                      <span
                        className={cn(
                          'w-3.5 h-3.5 rounded-[2px] border flex items-center justify-center shrink-0',
                          col.getIsVisible()
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-border',
                        )}
                        aria-hidden="true"
                      >
                        {col.getIsVisible() && (
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none">
                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                          </svg>
                        )}
                      </span>
                      <span className="truncate capitalize">{label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
