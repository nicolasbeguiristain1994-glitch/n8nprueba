'use client'

/**
 * Checkbox — componente oficial usando @base-ui/react (base-nova style).
 *
 * Wrapper sobre Checkbox.Root + Checkbox.Indicator de @base-ui/react.
 * API compatible con el resto de shadcn/ui base-nova del proyecto.
 *
 * Props principales:
 *   - checked / defaultChecked / indeterminate
 *   - onCheckedChange(checked: boolean, eventDetails)
 *   - disabled / readOnly / required / name / value
 */

import * as React from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CheckboxProps extends CheckboxPrimitive.Root.Props {
  className?: string
}

const Checkbox = React.forwardRef<HTMLElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <CheckboxPrimitive.Root
      ref={ref}
      data-slot="checkbox"
      className={cn(
        // Tamaño y forma
        'peer h-4 w-4 shrink-0 rounded-[3px]',
        // Borde y fondo base
        'border border-input bg-background',
        // Estado checked — fondo primary
        'data-[checked]:bg-primary data-[checked]:border-primary data-[checked]:text-primary-foreground',
        // Estado indeterminate
        'data-[indeterminate]:bg-primary data-[indeterminate]:border-primary data-[indeterminate]:text-primary-foreground',
        // Focus ring
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        // Disabled
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Layout
        'cursor-pointer inline-flex items-center justify-center',
        'transition-colors duration-150',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="flex items-center justify-center text-current"
        keepMounted
      >
        {/* Indeterminate — guion horizontal */}
        <Minus
          size={10}
          strokeWidth={3.5}
          className="hidden [[data-indeterminate]_&]:block"
          aria-hidden="true"
        />
        {/* Checked — check mark */}
        <Check
          size={10}
          strokeWidth={3.5}
          className="hidden [[data-checked]:not([data-indeterminate])_&]:block"
          aria-hidden="true"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  ),
)
Checkbox.displayName = 'Checkbox'

export { Checkbox }
