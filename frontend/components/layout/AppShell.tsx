'use client'

// Shared workspace frame. Preferences remain in localStorage; the hydration
// snapshot keeps server and client markup consistent before applying them.

import { useState, useMemo, useCallback, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import { CurrentUserProvider } from '@/lib/useCurrentUser'
import { SidebarContext } from './sidebar-context'
import { Sidebar, MobileSidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileNav } from './MobileNav'
import { CommandPalette } from './CommandPalette'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { Footer } from './Footer'
import { useConversationViewport } from '@/hooks/useConversationViewport'
import styles from './AppShell.module.css'

interface AppShellProps {
  children: React.ReactNode
}

const subscribeHydration = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname()
  const isConversations = pathname === '/conversations'
  const viewport = useConversationViewport(isConversations)
  // Apply the saved width after hydration without discarding the preference.
  const [savedCollapsed, setCollapsed] = useLocalStorage('sidebar:collapsed', false)
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot)
  const collapsed = hydrated && savedCollapsed
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
    <CurrentUserProvider refreshKey={pathname}>
    <SidebarContext.Provider value={sidebarContext}>
      <a href="#main-content" className="skip-link">Ir al contenido principal</a>
      <div className={`flex h-dvh w-full bg-background overflow-hidden ${isConversations ? styles.conversations : ''}`} data-keyboard-open={viewport?.keyboardOpen || undefined} style={viewport ? { height: viewport.height, top: viewport.top } : undefined}>
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
          <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 min-w-0 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0 flex flex-col outline-none">
            <div className={`flex-1 min-w-0 ${isConversations ? styles.content : ''}`}>{children}</div>
            {!isConversations && <Footer />}
          </main>
        </div>
      </div>

      {/* Sheet lateral — visible solo en mobile */}
      <MobileSidebar />

      {/* Bottom nav — visible solo en mobile */}
      {!viewport?.keyboardOpen && <MobileNav />}

      {/* Command palette global — se monta siempre para registrar Cmd+K */}
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </SidebarContext.Provider>
    </CurrentUserProvider>
  )
}
