'use client'

/**
 * Sidebar — navegación lateral de la app.
 *
 * Exporta dos componentes:
 *   - <Sidebar />      → sidebar desktop (hidden en mobile)
 *   - <MobileSidebar /> → sheet lateral para mobile (montado desde AppShell)
 *
 * Comportamiento:
 *   - Desktop: ancho 220px (expandido) ↔ 58px (colapsado, solo iconos)
 *   - Colapsado: transición CSS suave, tooltips nativos en cada ítem
 *   - Botón toggle flotante sobre el borde derecho del sidebar
 *   - Role-based: admins ven todos los items; operators solo sus sectores
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Users, Megaphone, MessageSquare,
  Activity, Flame, UserCog, Settings, FileText,
  BarChart2, ShieldOff, Bot, ChevronLeft, LogOut, X,
  ClipboardList, CheckSquare, CalendarDays, HelpCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSidebar } from './sidebar-context'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Configuración de navegación
// ---------------------------------------------------------------------------

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  sector: string
}

const BASE_NAV: NavItem[] = [
  { href: '/',               label: 'Dashboard',       icon: LayoutDashboard, sector: 'dashboard' },
  { href: '/contacts',       label: 'Contactos',        icon: Users,           sector: 'contacts' },
  { href: '/campaigns',      label: 'Campañas',         icon: Megaphone,       sector: 'campaigns' },
  { href: '/conversations',  label: 'Conversaciones',   icon: MessageSquare,   sector: 'conversations' },
  { href: '/lines',          label: 'Líneas',           icon: Activity,        sector: 'lines' },
  { href: '/warmup',         label: 'Calentamiento',    icon: Flame,           sector: 'warmup' },
  { href: '/mis-tareas',     label: 'Mis Tareas',       icon: CheckSquare,     sector: 'tasks' },
  { href: '/calendario',     label: 'Calendario',       icon: CalendarDays,    sector: 'tasks' },
  { href: '/estadisticas',   label: 'Estadísticas',     icon: BarChart2,       sector: 'estadisticas' },
  { href: '/automatizaciones',label: 'Automatizaciones',icon: Bot,             sector: 'automations' },
  { href: '/blacklist',      label: 'Blacklist',        icon: ShieldOff,       sector: 'blacklist' },
  { href: '/templates',      label: 'Plantillas',       icon: FileText,        sector: 'templates' },
]

const ADMIN_NAV: NavItem[] = [
  { href: '/tareas',    label: 'Tareas',    icon: ClipboardList, sector: 'tasks' },
  { href: '/users',     label: 'Usuarios',  icon: UserCog,       sector: 'users' },
  { href: '/settings',  label: 'Ajustes',   icon: Settings,      sector: 'settings' },
]

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 border-b border-sidebar-border shrink-0 h-14',
        collapsed ? 'justify-center px-0' : 'px-4',
      )}
    >
      <div className="w-7 h-7 bg-green-500 rounded-lg flex items-center justify-center shrink-0">
        <span className="text-white text-xs font-bold select-none">WA</span>
      </div>
      {!collapsed && (
        <span className="font-semibold text-sm text-sidebar-foreground truncate">
          WA Platform
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ítem de navegación individual
// ---------------------------------------------------------------------------

function NavLink({
  item,
  collapsed,
  onClick,
}: {
  item: NavItem
  collapsed: boolean
  onClick?: () => void
}) {
  const pathname = usePathname()
  // Match exacto para "/" (dashboard), prefijo para el resto
  const isActive =
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  const Icon = item.icon

  return (
    <Link
      href={item.href}
      onClick={onClick}
      // title activa el tooltip nativo del browser cuando está colapsado
      title={collapsed ? item.label : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg text-sm font-medium',
        'transition-all duration-200',
        // Dimensiones según estado
        collapsed ? 'h-9 w-9 justify-center' : 'h-9',
        // Padding no-collapsed: activo compensa los 3px del borde izquierdo
        !collapsed && (isActive ? 'pl-[9px] pr-3' : 'px-3'),
        // Estilos activo / hover
        isActive
          ? collapsed
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'bg-gradient-to-r from-primary/10 to-primary/[.03] text-primary border-l-[3px] border-primary/70 font-semibold'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      <Icon size={16} className="shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Cuerpo del sidebar (compartido por desktop y mobile sheet)
// ---------------------------------------------------------------------------

function SidebarContent({
  collapsed,
  onClose,
}: {
  collapsed: boolean
  onClose?: () => void
}) {
  const router = useRouter()
  const { user } = useCurrentUser()
  const isAdmin = user?.role === 'admin'

  const allNav = [...BASE_NAV, ...ADMIN_NAV]
  // Admin ve todo; operator solo sus sectores asignados
  const nav = isAdmin
    ? allNav
    : allNav.filter(item => user?.sectors?.includes(item.sector))

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="flex flex-col h-full bg-sidebar">
      {/* Botón cerrar — solo visible en el sheet mobile */}
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3 p-1.5 rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          aria-label="Cerrar menú"
        >
          <X size={16} />
        </button>
      )}

      <Logo collapsed={collapsed} />

      {/* Lista de navegación */}
      <nav
        className={cn(
          'flex-1 py-3 space-y-0.5 overflow-y-auto',
          collapsed ? 'px-[11px]' : 'px-3',
        )}
        aria-label="Navegación principal"
      >
        {nav.map(item => (
          <NavLink
            key={item.href}
            item={item}
            collapsed={collapsed}
            onClick={onClose}
          />
        ))}
      </nav>

      {/* Footer: usuario + logout */}
      <div
        className={cn(
          'border-t border-sidebar-border py-3 space-y-0.5',
          collapsed ? 'px-[11px]' : 'px-3',
        )}
      >
        {/* Info del usuario — solo en modo expandido */}
        {!collapsed && user && (
          <div className="px-3 py-2">
            <p className="text-xs font-medium text-sidebar-foreground truncate">
              {user.name ?? user.email}
            </p>
            <p className="text-[11px] text-sidebar-foreground/50 capitalize">
              {user.role}
            </p>
          </div>
        )}

        {/* Ayuda — siempre visible sin importar el rol */}
        <Link
          href="/ayuda"
          title={collapsed ? 'Guía de uso' : undefined}
          className={cn(
            'flex items-center gap-3 rounded-lg text-sm font-medium',
            'transition-colors duration-150',
            'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            collapsed ? 'h-9 w-9 justify-center' : 'h-9 px-3',
          )}
        >
          <HelpCircle size={16} className="shrink-0" />
          {!collapsed && <span>Guía de uso</span>}
        </Link>

        <button
          onClick={logout}
          title={collapsed ? 'Cerrar sesión' : undefined}
          className={cn(
            'flex items-center gap-3 rounded-lg text-sm font-medium w-full',
            'transition-colors duration-150',
            'text-sidebar-foreground/60 hover:bg-destructive/10 hover:text-destructive',
            collapsed ? 'h-9 w-9 justify-center' : 'h-9 px-3',
          )}
        >
          <LogOut size={16} className="shrink-0" />
          {!collapsed && <span>Cerrar sesión</span>}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar desktop
// ---------------------------------------------------------------------------

export function Sidebar() {
  const { collapsed, toggle } = useSidebar()

  return (
    <aside
      /*
       * suppressHydrationWarning: el ancho depende de localStorage (useLocalStorage).
       * En SSR se renderiza con el valor inicial (collapsed=false → w-56).
       * En cliente puede diferir si estaba colapsado. React lo corrige sin flash
       * visual porque solo afecta una clase de width, no contenido significativo.
       * Mismo patrón que usa next-themes con el atributo class en <html>.
       */
      suppressHydrationWarning
      className={cn(
        'relative hidden md:flex flex-col shrink-0',
        'border-r border-sidebar-border',
        'transition-[width] duration-200 ease-in-out overflow-hidden',
        collapsed ? 'w-[58px]' : 'w-56',
      )}
    >
      <SidebarContent collapsed={collapsed} />

      {/*
       * Toggle button flotante sobre el borde derecho.
       * Posicionado con `absolute -right-3` para que quede mitad dentro/fuera.
       */}
      <button
        onClick={toggle}
        className={cn(
          'absolute -right-3 top-[72px] z-10',
          'flex items-center justify-center w-6 h-6 rounded-full',
          'bg-background border border-border shadow-sm',
          'text-muted-foreground hover:text-foreground hover:border-border/80',
          'transition-transform duration-200',
          collapsed && 'rotate-180',
        )}
        aria-label={collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
      >
        <ChevronLeft size={12} />
      </button>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Mobile sidebar (sheet desde la izquierda)
// ---------------------------------------------------------------------------

export function MobileSidebar() {
  const { mobileOpen, setMobileOpen } = useSidebar()

  if (!mobileOpen) return null

  return (
    <>
      {/* Overlay semitransparente */}
      <div
        className="fixed inset-0 z-40 bg-black/50 md:hidden"
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      {/* Sheet */}
      <aside className="fixed inset-y-0 left-0 z-50 w-64 md:hidden shadow-xl">
        {/* relative para el botón de cerrar posicionado absolutamente */}
        <div className="relative h-full">
          <SidebarContent
            collapsed={false}
            onClose={() => setMobileOpen(false)}
          />
        </div>
      </aside>
    </>
  )
}
