import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Progress — barra simple y accesible.
 *
 * Sin dependencias externas. Se usa en la encuesta pública para mostrar
 * "1 de 5". Si en el futuro necesitamos animaciones o indeterminado,
 * migrar a @base-ui/react/progress.
 */
export interface ProgressProps extends React.ComponentProps<'div'> {
  value: number      // 0-100
  max?: number       // default 100
}

function Progress({ className, value, max = 100, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-muted',
        className,
      )}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export { Progress }
