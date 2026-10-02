'use client'

import { Menu, Search, ChevronRight } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useSidebar } from './sidebar-context'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'
import { routeLabel } from './navigation'

export function Topbar({ onSearchClick }: { onSearchClick?: () => void }) {
  const { setMobileOpen } = useSidebar()
  const pathname = usePathname()
  return <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 sm:px-6 lg:px-8">
    <button onClick={() => setMobileOpen(true)} className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted md:hidden" aria-label="Abrir menú"><Menu size={18} /></button>
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className="hidden text-muted-foreground lg:inline">Workspace</span>
      <ChevronRight size={13} className="hidden text-muted-foreground/60 lg:block" aria-hidden="true" />
      <span className="truncate font-medium text-foreground">{routeLabel(pathname)}</span>
    </div>
    <div className="flex-1" />
    <button onClick={onSearchClick} className="hidden h-8 w-56 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:border-input hover:bg-muted md:flex" aria-label="Abrir búsqueda global">
      <Search size={14} /><span className="flex-1 text-left">Buscar o ir a…</span><kbd className="rounded border bg-card px-1 py-0.5 text-[10px]">⌘ K</kbd>
    </button>
    <button onClick={onSearchClick} className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted md:hidden" aria-label="Buscar"><Search size={17} /></button>
    <div className="flex shrink-0 items-center gap-2 sm:border-l sm:pl-3"><NotificationBell /><UserMenu /></div>
  </header>
}
