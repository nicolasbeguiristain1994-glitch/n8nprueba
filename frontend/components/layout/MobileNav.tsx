'use client'

/**
 * MobileNav — barra de navegación inferior para mobile.
 *
 * Solo visible en pantallas < md (768px).
 * AppShell agrega pb-16 al <main> para compensar la altura de esta barra.
 *
 * Configurable: acepta un array `items` con los íconos a mostrar.
 * Por defecto muestra los 4 destinos principales de la plataforma.
 *
 * @example
 * // Uso con items por defecto (la mayoría de los casos)
 * <MobileNav />
 *
 * @example
 * // Uso con items personalizados
 * <MobileNav items={[
 *   { href: '/',         label: 'Inicio',    icon: LayoutDashboard },
 *   { href: '/contacts', label: 'Contactos', icon: Users },
 * ]} />
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  Megaphone,
  MessageSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface MobileNavItem {
  href: string
  label: string
  icon: LucideIcon
}

// ---------------------------------------------------------------------------
// Default items — los 4 destinos más usados de la plataforma
// ---------------------------------------------------------------------------

const DEFAULT_ITEMS: MobileNavItem[] = [
  { href: '/',              label: 'Inicio',    icon: LayoutDashboard },
  { href: '/contacts',      label: 'Contactos', icon: Users },
  { href: '/campaigns',     label: 'Campañas',  icon: Megaphone },
  { href: '/conversations', label: 'Mensajes',  icon: MessageSquare },
]

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

interface MobileNavProps {
  /**
   * Items a mostrar en la barra.
   * Máximo recomendado: 5. Si se omite, usa DEFAULT_ITEMS.
   */
  items?: MobileNavItem[]
}

export function MobileNav({ items = DEFAULT_ITEMS }: MobileNavProps) {
  const pathname = usePathname()

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-30 md:hidden bg-background/95 backdrop-blur-sm border-t border-border"
      aria-label="Navegación mobile"
    >
      <div className="flex items-center justify-around h-16">
        {items.map(({ href, label, icon: Icon }) => {
          const isActive =
            href === '/' ? pathname === '/' : pathname.startsWith(href)

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center gap-1 px-3 py-2 rounded-lg',
                'transition-colors duration-150 min-w-[56px]',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon
                size={20}
                strokeWidth={isActive ? 2.5 : 2}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'text-[10px] font-medium',
                  isActive && 'font-semibold',
                )}
              >
                {label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
