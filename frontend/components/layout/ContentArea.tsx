/**
 * ContentArea — wrapper de contenido con padding consistente.
 *
 * Proporciona:
 *   - Padding horizontal y vertical responsive (mobile más comprimido)
 *   - Opción de limitar el ancho máximo con max-w-7xl (para páginas de formulario)
 *   - Slot directo: envuelve <children> sin estructura extra
 *
 * Uso estándar (la mayoría de páginas):
 *   <ContentArea>{children}</ContentArea>
 *
 * Con ancho máximo (settings, formularios):
 *   <ContentArea maxWidth>{children}</ContentArea>
 *
 * Sin padding (páginas full-bleed como conversaciones):
 *   <ContentArea noPadding>{children}</ContentArea>
 *
 * Server Component — no requiere 'use client'.
 */

import { cn } from '@/lib/utils'

interface ContentAreaProps {
  children: React.ReactNode
  /** Agrega max-w-7xl y mx-auto para centrar el contenido */
  maxWidth?: boolean
  /** Desactiva el padding interno (para layouts full-bleed) */
  noPadding?: boolean
  /** Clases adicionales para el wrapper */
  className?: string
}

export function ContentArea({
  children,
  maxWidth = false,
  noPadding = false,
  className,
}: ContentAreaProps) {
  return (
    <div
      className={cn(
        'page-content mx-auto',
        !noPadding && 'px-4 py-5 sm:px-6 lg:px-8 lg:py-7',
        maxWidth && 'max-w-7xl mx-auto',
        className,
      )}
    >
      {children}
    </div>
  )
}
