'use client'

/**
 * Topbar — barra superior fija de la app.
 *
 * Secciones:
 *   LEFT:   hamburger (mobile only) + logo (mobile only)
 *   CENTER: buscador global con hint Cmd+K (desktop only)
 *   RIGHT:  ícono búsqueda (mobile) + notificaciones + toggle dark/light + avatar
 *
 * La altura es h-14 (56px), coincide con el skeleton en AppShell y el logo en Sidebar.
 * z-30 para quedar sobre el contenido scrolleable pero bajo modals/dialogs.
 */

import { Menu, Bell, Search, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { useSidebar } from './sidebar-context'
import { useCurrentUser } from '@/lib/useCurrentUser'

export function Topbar() {
  const { setMobileOpen } = useSidebar()
  const { resolvedTheme, setTheme } = useTheme()
  const { user } = useCurrentUser()

  // Evitar hidration mismatch con el ícono del tema (SSR no conoce preferencia)
  const [themeMounted, setThemeMounted] = useState(false)
  useEffect(() => setThemeMounted(true), [])

  // Iniciales para el avatar (máx 2 caracteres)
  const initials = user?.name
    ? user.name
        .split(' ')
        .map(n => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : (user?.email?.slice(0, 2).toUpperCase() ?? '··')

  const toggleTheme = () =>
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')

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

      {/* ── Desktop: buscador central ── */}
      <div className="hidden md:flex flex-1 max-w-xs">
        <button
          className="flex items-center gap-2 w-full h-8 px-3 rounded-md border border-input bg-muted/40 text-sm text-muted-foreground hover:bg-muted transition-colors"
          aria-label="Búsqueda global"
          // TODO: conectar con cmdk cuando se instale
          onClick={() => {}}
        >
          <Search size={14} className="shrink-0" />
          <span className="flex-1 text-left">Buscar…</span>
          <kbd className="hidden sm:flex items-center gap-0.5 text-[10px] bg-background border border-border rounded px-1.5 py-0.5 font-mono text-muted-foreground/70">
            <span>⌘</span><span>K</span>
          </kbd>
        </button>
      </div>

      {/* Espaciador flexible — empuja los íconos a la derecha en mobile */}
      <div className="flex-1" />

      {/* ── Right actions ── */}
      <div className="flex items-center gap-0.5">

        {/* Búsqueda mobile (ícono solo) */}
        <button
          className="md:hidden flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label="Buscar"
        >
          <Search size={16} />
        </button>

        {/* Notificaciones */}
        <button
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors relative"
          aria-label="Notificaciones"
        >
          <Bell size={16} />
          {/* Badge de notificaciones — descomentar cuando haya lógica real */}
          {/* <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-destructive" /> */}
        </button>

        {/* Toggle dark / light mode */}
        <button
          onClick={toggleTheme}
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label={resolvedTheme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
        >
          {/* Renderizar solo tras montar para evitar mismatch */}
          {themeMounted ? (
            resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />
          ) : (
            <Moon size={16} />
          )}
        </button>

        {/* Avatar del usuario */}
        <div
          title={user?.name ?? user?.email ?? ''}
          className="ml-1 w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-semibold cursor-pointer select-none shrink-0"
        >
          {initials}
        </div>
      </div>
    </header>
  )
}
