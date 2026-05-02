'use client'

/**
 * MobileNav — barra de navegación inferior para mobile.
 *
 * Solo visible en pantallas < md (768px).
 * Muestra los 4 destinos más importantes; el resto queda accesible
 * desde el sidebar sheet (hamburger en Topbar).
 *
 * Posición fixed bottom-0 para no ocupar espacio en el layout.
 * AppShell agrega pb-16 al <main> para compensar la altura de esta barra.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  Megaphone,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const BOTTOM_NAV = [
  { href: '/',              label: 'Inicio',    icon: LayoutDashboard },
  { href: '/contacts',      label: 'Contactos', icon: Users },
  { href: '/campaigns',     label: 'Campañas',  icon: Megaphone },
  { href: '/conversations', label: 'Mensajes',  icon: MessageSquare },
] as const

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-30 md:hidden bg-background border-t border-border"
      aria-label="Navegación mobile"
    >
      <div className="flex items-center justify-around h-16 safe-area-inset-bottom">
        {BOTTOM_NAV.map(({ href, label, icon: Icon }) => {
          const isActive =
            href === '/' ? pathname === '/' : pathname.startsWith(href)

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center gap-1 px-4 py-2 rounded-lg',
                'transition-colors duration-150 min-w-[60px]',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
              <span className={cn('text-[10px] font-medium', isActive && 'font-semibold')}>
                {label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
