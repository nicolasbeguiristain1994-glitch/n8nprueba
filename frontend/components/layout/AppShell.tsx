'use client'

/**
 * AppShell — raíz del layout de la app autenticada.
 *
 * Estructura visual:
 *   ┌──────────┬──────────────────────────────────────┐
 *   │ Sidebar  │ Topbar (56px fija)                   │
 *   │ (desktop)│──────────────────────────────────────│
 *   │          │ <children> (scroll independiente)    │
 *   └──────────┴──────────────────────────────────────┘
 *   [MobileNav bottom bar — solo en mobile]
 *   [CommandPalette — overlay global Cmd+K]
 *
 * Optimización de re-renders:
 *   - SidebarContext.value está memoizado con useMemo.
 *     Cambios en `cmdOpen` NO re-renderizan Sidebar ni MobileNav.
 *   - `collapsed` y `toggle` viven en useLocalStorage (sin useEffect).
 *   - `mobileOpen` es estado local de AppShell (bajo impacto).
 *
 * Sin skeleton:
 *   useLocalStorage lee localStorage síncronamente en el primer render del
 *   cliente. El <aside> del Sidebar tiene suppressHydrationWarning para el
 *   caso en que el valor de SSR (false) difiera del de localStorage.
 */

import { useState, useMemo, useCallback } from 'react'
import { SidebarContext } from './sidebar-context'
import { Sidebar, MobileSidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileNav } from './MobileNav'
import { CommandPalette } from './CommandPalette'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { Footer } from './Footer'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  // Estado del sidebar — síncrono en cliente, sin flash
  const [collapsed, setCollapsed] = useLocalStorage('sidebar:collapsed', false)
  const toggle = useCallback(() => setCollapsed(v => !v), [setCollapsed])

  // Estado del sheet mobile — solo local, no necesita persistencia
  const [mobileOpen, setMobileOpen] = useState(false)

  // Estado de la command palette — aislado del contexto del sidebar
  const [cmdOpen, setCmdOpen] = useState(false)

  // Memoizar el valor del contexto evita re-renders en Sidebar/MobileNav
  // cuando solo cambia cmdOpen (que no está en el contexto)
  const sidebarContext = useMemo(
    () => ({ collapsed, toggle, mobileOpen, setMobileOpen }),
    [collapsed, toggle, mobileOpen],
  )

  return (
    <SidebarContext.Provider value={sidebarContext}>
      <div className="flex h-screen w-full bg-background overflow-hidden">
        {/* Sidebar desktop — hidden en mobile */}
        <Sidebar />

        {/* Columna derecha: topbar + área scrolleable */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          {/*
           * onSearchClick abre la CommandPalette desde el botón de búsqueda
           * del Topbar. El shortcut Cmd+K vive dentro del CommandPalette.
           */}
          <Topbar onSearchClick={() => setCmdOpen(true)} />

          {/* pb-16 md:pb-0 → reserva espacio para MobileNav en mobile */}
          <main className="flex-1 overflow-y-auto pb-16 md:pb-0 flex flex-col">
            <div className="flex-1">{children}</div>
            <Footer />
          </main>
        </div>
      </div>

      {/* Sheet lateral — visible solo en mobile */}
      <MobileSidebar />

      {/* Bottom nav — visible solo en mobile */}
      <MobileNav />

      {/* Command palette global — se monta siempre para registrar Cmd+K */}
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </SidebarContext.Provider>
  )
}
