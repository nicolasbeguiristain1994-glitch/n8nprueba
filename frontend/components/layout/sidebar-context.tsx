'use client'

/**
 * SidebarContext — estado compartido entre AppShell, Sidebar y Topbar.
 * Separado en su propio archivo para evitar dependencias circulares.
 */

import { createContext, useContext } from 'react'

export interface SidebarContextValue {
  /** true = sidebar colapsado (solo iconos, 58px) */
  collapsed: boolean
  /** Alterna el estado collapsed y persiste en localStorage */
  toggle: () => void
  /** true = sheet mobile abierto */
  mobileOpen: boolean
  setMobileOpen: (open: boolean) => void
}

export const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  toggle: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
})

/** Hook para consumir el contexto del sidebar desde cualquier componente hijo. */
export function useSidebar(): SidebarContextValue {
  return useContext(SidebarContext)
}
