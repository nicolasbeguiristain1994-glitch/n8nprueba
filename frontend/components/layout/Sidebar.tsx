'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { PanelLeftClose, PanelLeftOpen, LogOut, HelpCircle, X } from 'lucide-react'
import { Dialog } from '@base-ui/react/dialog'
import { useSidebar } from './sidebar-context'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { cn } from '@/lib/utils'
import { Brand } from './Brand'
import { BASE_NAV, ADMIN_NAV, NAV_GROUPS, type NavItem } from './navigation'

function NavLink({ item, collapsed, onClick }: { item: NavItem; collapsed: boolean; onClick?: () => void }) {
  const pathname = usePathname()
  const active = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(item.href + '/')
  const Icon = item.icon
  return <Link href={item.href} onClick={onClick} title={collapsed ? item.label : undefined}
    aria-label={collapsed ? item.label : undefined} aria-current={active ? 'page' : undefined}
    className={cn('relative flex h-9 items-center gap-2.5 rounded-md text-[13px] transition-colors duration-150',
      collapsed ? 'w-9 justify-center' : 'px-2.5',
      active ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground' : 'font-medium text-sidebar-foreground/80 hover:bg-muted hover:text-foreground')}>
    <Icon size={16} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
    {!collapsed && <span className="truncate">{item.label}</span>}
    {!collapsed && active && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
  </Link>
}

function SidebarContent({ collapsed, onClose }: { collapsed: boolean; onClose?: () => void }) {
  const router = useRouter()
  const { user } = useCurrentUser()
  const nav = [...BASE_NAV, ...ADMIN_NAV].filter(item => user?.role === 'admin' || user?.sectors?.includes(item.sector))
  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.push('/login') }
  return <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
    <div className={cn('flex h-16 shrink-0 items-center border-b border-sidebar-border', collapsed ? 'justify-center' : 'px-4')}>
      <Brand compact={collapsed} />
      {onClose && <button onClick={onClose} aria-label="Cerrar menú" className="ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"><X size={18} /></button>}
    </div>
    <nav aria-label="Navegación principal" className={cn('min-h-0 flex-1 overflow-y-auto py-3', collapsed ? 'px-3.5' : 'px-3')}>
      {NAV_GROUPS.map(group => {
        const items = group.paths.flatMap(path => nav.filter(item => item.href === path))
        if (!items.length) return null
        return <div key={group.label} className="mb-4 last:mb-0">
          {!collapsed && <p className="px-2.5 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{group.label}</p>}
          {collapsed && group !== NAV_GROUPS[0] && <div className="mx-2 mb-3 border-t border-sidebar-border" />}
          <div className="space-y-0.5">{items.map(item => <NavLink key={item.href} item={item} collapsed={collapsed} onClick={onClose} />)}</div>
        </div>
      })}
    </nav>
    <div className={cn('shrink-0 border-t border-sidebar-border py-2.5', collapsed ? 'px-3.5' : 'px-3')}>
      <Link href="/ayuda" onClick={onClose} title="Guía de uso" aria-label={collapsed ? 'Guía de uso' : undefined} className={cn('flex h-9 items-center gap-2.5 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground', collapsed ? 'w-9 justify-center' : 'px-2.5')}><HelpCircle size={16} />{!collapsed && 'Guía de uso'}</Link>
      <button onClick={logout} title="Cerrar sesión" aria-label={collapsed ? 'Cerrar sesión' : undefined} className={cn('flex h-9 w-full items-center gap-2.5 rounded-md text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive', collapsed ? 'justify-center' : 'px-2.5')}><LogOut size={16} />{!collapsed && 'Cerrar sesión'}</button>
      {!collapsed && user && <div className="mt-2 flex items-center gap-2.5 border-t border-sidebar-border px-2.5 pt-3 pb-1">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card text-[11px] font-semibold text-primary">{(user.name || user.email).slice(0, 2).toUpperCase()}</div>
        <div className="min-w-0"><p className="truncate text-xs font-medium">{user.name ?? user.email}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{user.role === 'admin' ? 'Administrador' : user.role === 'operator' ? 'Operador' : 'Solo lectura'}</p></div>
      </div>}
    </div>
  </div>
}

export function Sidebar() {
  const { collapsed, toggle } = useSidebar()
  return <aside suppressHydrationWarning className={cn('relative hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:flex', collapsed ? 'w-16' : 'w-[232px]')}>
    <div className="min-h-0 flex-1 overflow-hidden"><SidebarContent collapsed={collapsed} /></div>
    <button onClick={toggle} aria-label={collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'} aria-expanded={!collapsed} className="flex h-10 shrink-0 items-center justify-center gap-2 border-t border-sidebar-border text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
      {collapsed ? <PanelLeftOpen size={16} /> : <><PanelLeftClose size={16} /> Contraer menú</>}
    </button>
  </aside>
}

export function MobileSidebar() {
  const { mobileOpen, setMobileOpen } = useSidebar()
  return <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 data-open:animate-in data-open:fade-in-0 duration-150" />
      <Dialog.Popup className="fixed inset-y-0 left-0 z-50 w-72 max-w-[calc(100vw-2rem)] outline-none shadow-xl data-open:animate-in data-open:slide-in-from-left-4 duration-150">
        <Dialog.Title className="sr-only">Menú de navegación</Dialog.Title>
        <SidebarContent collapsed={false} onClose={() => setMobileOpen(false)} />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
