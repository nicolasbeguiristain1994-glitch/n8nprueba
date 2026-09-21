'use client'

/**
 * RadioGroup — wrapper sobre @base-ui/react/radio con el estilo del proyecto.
 */

import * as React from 'react'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { cn } from '@/lib/utils'

function RadioGroup({
  className,
  ...props
}: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('grid gap-2', className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        'peer inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-input bg-background',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[checked]:border-primary',
        'transition-colors duration-150 cursor-pointer',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        className="flex items-center justify-center"
        keepMounted
      >
        <span
          className="hidden [[data-checked]_&]:block h-2 w-2 rounded-full bg-primary"
          aria-hidden="true"
        />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem }
