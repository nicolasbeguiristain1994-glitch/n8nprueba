'use client'

/**
 * Topbar — barra superior fija de la app.
 *
 * Secciones:
 *   LEFT:   hamburger (mobile) + logo (mobile)
 *   CENTER: botón de búsqueda global con hint Cmd+K (desktop)
 *   RIGHT:  búsqueda mobile | NotificationBell | UserMenu
 *
 * El toggle de tema y el logout viven en <UserMenu> para mantener el Topbar
 * limpio. Esta separación es la misma que usan Attio y Linear.
 *
 * Props:
 *   onSearchClick — callback que dispara el CommandPalette desde AppShell.
 *                   El shortcut Cmd+K también lo maneja el CommandPalette
 *                   internamente, pero este botón es el punto de entrada visual.
 */

import { Menu, Search } from 'lucide-react'
import { useSidebar } from './sidebar-context'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'

interface TopbarProps {
  onSearchClick?: () => void
}

export function Topbar({ onSearchClick }: TopbarProps) {
  const { setMobileOpen } = useSidebar()

  return (
    <header className="h-14 shrink-0 z-30 sticky top-0 flex items-center gap-3 px-4 bg-background/95 backdrop-blur-sm border-b border-border">

      {/* ── Mobile: hamburger ── */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        aria-label="Abrir menú"
      >
        <Menu size={18} />
      </button>

      {/* ── Mobile: logo inline ── */}
      <div className="md:hidden flex items-center gap-2">
        <div className="w-6 h-6 bg-green-500 rounded-md flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold select-none">WA</span>
        </div>
        <span className="font-semibold text-sm">WA Platform</span>
      </div>

      {/* ── Desktop: botón de búsqueda global ── */}
      <div className="hidden md:flex flex-1 max-w-xs">
        <button
          onClick={onSearchClick}
          className="flex items-center gap-2 w-full h-8 px-3 rounded-md border border-input bg-muted/40 text-sm text-muted-foreground hover:bg-muted transition-colors"
          aria-label="Abrir búsqueda global"
        >
          <Search size={14} className="shrink-0" />
          <span className="flex-1 text-left">Buscar…</span>
          <kbd className="hidden sm:flex items-center gap-0.5 text-[10px] bg-background border border-border rounded px-1.5 py-0.5 font-mono text-muted-foreground/70">
            <span>⌘</span><span>K</span>
          </kbd>
        </button>
      </div>

      {/* Espaciador — empuja las acciones a la derecha en mobile */}
      <div className="flex-1" />

      {/* ── Right actions ── */}
      <div className="flex items-center gap-0.5">

        {/* Búsqueda mobile (ícono solo) */}
        <button
          onClick={onSearchClick}
          className="md:hidden flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label="Buscar"
        >
          <Search size={16} />
        </button>

        {/* Notificaciones — componente completo con dropdown */}
        <NotificationBell />

        {/* Usuario — avatar + dropdown (theme toggle + logout) */}
        <div className="ml-0.5">
          <UserMenu />
        </div>
      </div>
    </header>
  )
}
