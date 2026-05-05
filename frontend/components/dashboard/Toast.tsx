'use client'

import { memo } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ToastProps {
  visible: boolean
  message: string
}

export const Toast = memo(function Toast({ visible, message }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'fixed bottom-6 right-6 z-50 flex items-center gap-2',
        'bg-popover border rounded-xl shadow-md px-4 py-2.5 text-sm',
        'ring-1 ring-foreground/10 select-none',
        'transition-all duration-200 ease-out',
        visible
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-2 pointer-events-none',
      )}
    >
      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
      <span>{message}</span>
    </div>
  )
})
