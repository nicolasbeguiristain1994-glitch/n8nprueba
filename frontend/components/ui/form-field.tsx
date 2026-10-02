'use client'

import { Field } from '@base-ui/react/field'
import { cn } from '@/lib/utils'

export function FormField({ label, hint, children, className }: {
  label: string; hint?: string; children: React.ReactNode; className?: string
}) {
  return <Field.Root className={cn('grid items-start gap-3 border-b border-border py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]', className)}>
    <div>
      <Field.Label className="text-sm font-medium text-foreground">{label}</Field.Label>
      {hint && <Field.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</Field.Description>}
    </div>
    <div className="min-w-0">{children}</div>
  </Field.Root>
}
