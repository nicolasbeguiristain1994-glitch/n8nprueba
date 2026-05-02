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
 *
 * Responsividad:
 *   - Desktop (md+): sidebar lateral + topbar
 *   - Mobile (<md): sidebar oculto → sheet desde topbar + bottom nav
 *
 * Persistencia del estado collapsed: localStorage (key "sidebar:collapsed")
 * Se evita el flash SSR mostrando un skeleton hasta que el componente monta.
 */

import { useState, useEffect } from 'react'
import { SidebarContext } from './sidebar-context'
import { Sidebar, MobileSidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileNav } from './MobileNav'

const STORAGE_KEY = 'sidebar:collapsed'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mounted, setMounted] = useState(false)

  // Leer localStorage después del mount para evitar mismatch SSR/client
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) setCollapsed(stored === 'true')
    setMounted(true)
  }, [])

  const toggle = () =>
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })

  // Skeleton pre-mount: evita el layout shift al leer localStorage
  if (!mounted) {
    return (
      <div className="flex h-screen w-full bg-background overflow-hidden">
        {/* Sidebar placeholder — mismo ancho que el default (expanded) */}
        <div className="hidden md:flex w-56 shrink-0 bg-sidebar border-r border-sidebar-border" />
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <div className="h-14 shrink-0 bg-background border-b border-border" />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    )
  }

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, mobileOpen, setMobileOpen }}>
      {/* Layout principal */}
      <div className="flex h-screen w-full bg-background overflow-hidden">

        {/* Sidebar desktop (hidden en mobile) */}
        <Sidebar />

        {/* Columna derecha: topbar + contenido scrolleable */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <Topbar />
          {/*
           * pb-16 md:pb-0 → espacio para el bottom nav en mobile.
           * El scroll está en este <main>, no en el body.
           */}
          <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
            {children}
          </main>
        </div>
      </div>

      {/* Sheet del sidebar para mobile (portal sobre el layout) */}
      <MobileSidebar />

      {/* Bottom navigation — solo mobile */}
      <MobileNav />
    </SidebarContext.Provider>
  )
}
