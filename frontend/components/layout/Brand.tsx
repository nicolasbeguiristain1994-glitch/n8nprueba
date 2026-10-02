import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Brand({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <MessageSquare size={18} strokeWidth={1.8} aria-hidden="true" />
      </span>
      {!compact && <div className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold tracking-tight">WA Platform</span>
        <span className="mt-0.5 block text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">Workspace CRM</span>
      </div>}
    </div>
  )
}
