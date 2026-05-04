/**
 * PageHeader — encabezado estandarizado para cada página.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────┐
 *   │ [título]  [badge count]         [actions / children]│
 *   │ [description]                                      │
 *   └────────────────────────────────────────────────────┘
 *
 * Slots de acciones:
 *   `actions` prop   → ReactNode en el lado derecho (uso JSX clásico)
 *   `children`       → alias de `actions`; permite el patrón
 *                       <PageHeader title="X"><Button>Nuevo</Button></PageHeader>
 *
 *   Si se pasan los dos, `actions` tiene precedencia.
 *
 * Description:
 *   Acepta `ReactNode` — puede ser texto, un Badge, o cualquier elemento inline.
 *
 * Server Component — no requiere 'use client'.
 *
 * @example — uso básico
 *   <PageHeader title="Contactos" count={total} />
 *
 * @example — con children como acciones (patrón más natural)
 *   <PageHeader title="Campañas" count={campaigns.length}>
 *     <Button size="sm">Nueva campaña</Button>
 *   </PageHeader>
 *
 * @example — description como nodo (con badge de estado)
 *   <PageHeader
 *     title="Líneas"
 *     description={<span>Estado: <Badge>Activo</Badge></span>}
 *   />
 */

import { cn } from '@/lib/utils'

interface PageHeaderProps {
  /** Título principal de la página */
  title: string
  /**
   * Descripción bajo el título.
   * Acepta ReactNode para poder incluir badges, links, etc.
   */
  description?: React.ReactNode
  /** Número que se muestra como badge junto al título */
  count?: number
  /**
   * Slot para botones de acción alineados a la derecha.
   * Alias de `children` — si se pasan los dos, `actions` tiene precedencia.
   */
  actions?: React.ReactNode
  /**
   * Alternativa a `actions`. Permite el patrón:
   *   <PageHeader title="X"><Button>Nuevo</Button></PageHeader>
   */
  children?: React.ReactNode
  /** Clases adicionales para el wrapper externo */
  className?: string
}

export function PageHeader({
  title,
  description,
  count,
  actions,
  children,
  className,
}: PageHeaderProps) {
  // `actions` tiene precedencia; `children` es el fallback
  const actionsSlot = actions ?? children

  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 mb-6',
        className,
      )}
    >
      {/* ── Izquierda: título + badge + descripción ── */}
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
          <div className="mt-1 text-sm text-muted-foreground leading-snug">
            {description}
          </div>
        )}
      </div>

      {/* ── Derecha: acciones ── */}
      {actionsSlot && (
        <div className="flex items-center gap-2 flex-wrap justify-end shrink-0">
          {actionsSlot}
        </div>
      )}
    </div>
  )
}
