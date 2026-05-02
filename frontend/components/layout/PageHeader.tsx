/**
 * PageHeader — encabezado estandarizado para cada página.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────┐
 *   │ [título]  [badge count]       [actions slot]  │
 *   │ [description]                                 │
 *   └───────────────────────────────────────────────┘
 *
 * Uso básico:
 *   <PageHeader title="Contactos" count={total} />
 *
 * Con acciones:
 *   <PageHeader
 *     title="Campañas"
 *     count={campaigns.length}
 *     description="Gestiona tus envíos masivos"
 *     actions={<Button>Nueva campaña</Button>}
 *   />
 *
 * Es un Server Component (sin 'use client') — puede recibir ReactNode como actions.
 */

import { cn } from '@/lib/utils'

interface PageHeaderProps {
  /** Título principal de la página */
  title: string
  /** Descripción opcional bajo el título */
  description?: string
  /** Número que se muestra como badge junto al título (ej: total de registros) */
  count?: number
  /** Slot para botones de acción alineados a la derecha */
  actions?: React.ReactNode
  /** Clases adicionales para el wrapper externo */
  className?: string
}

export function PageHeader({
  title,
  description,
  count,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 mb-6',
        className,
      )}
    >
      {/* Lado izquierdo: título + badge + descripción */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-xl font-semibold text-foreground leading-tight">
            {title}
          </h1>

          {count !== undefined && (
            <span className="inline-flex items-center text-sm text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-medium tabular-nums shrink-0">
              {count.toLocaleString('es-AR')}
            </span>
          )}
        </div>

        {description && (
          <p className="mt-1 text-sm text-muted-foreground leading-snug">
            {description}
          </p>
        )}
      </div>

      {/* Lado derecho: acciones */}
      {actions && (
        <div className="flex items-center gap-2 flex-wrap justify-end shrink-0">
          {actions}
        </div>
      )}
    </div>
  )
}
