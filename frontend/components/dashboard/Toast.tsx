'use client'

import { memo } from 'react'
import { CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ToastProps {
  visible: boolean
  message: string
}

export const Toast = memo(function Toast({ visible, message }: ToastProps) {
  const isError = /error|no se pud|falló/i.test(message)
  const Icon = isError ? AlertCircle : CheckCircle2
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-hidden={!visible}
      className={cn(
        'fixed bottom-20 left-4 right-4 md:bottom-6 md:left-auto md:right-6 z-50 flex items-center gap-2',
        'bg-popover border rounded-xl shadow-md px-4 py-2.5 text-sm',
        'ring-1 ring-foreground/10 select-none',
        'transition-all duration-200 ease-out',
        visible
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-2 pointer-events-none',
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", isError ? "text-destructive" : "text-success")} />
      <span>{message}</span>
    </div>
  )
})
