'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, Users, Megaphone, MessageSquare, Activity, Flame, LogOut, UserCog, Settings, FileText, BarChart2 } from 'lucide-react'
import { useCurrentUser } from '@/lib/useCurrentUser'

const BASE_NAV = [
  { href: '/',               label: 'Dashboard',      icon: LayoutDashboard, sector: 'dashboard' },
  { href: '/contacts',       label: 'Contactos',       icon: Users,           sector: 'contacts' },
  { href: '/campaigns',      label: 'Campañas',        icon: Megaphone,       sector: 'campaigns' },
  { href: '/conversations',  label: 'Conversaciones',  icon: MessageSquare,   sector: 'conversations' },
  { href: '/lines',          label: 'Líneas',          icon: Activity,        sector: 'lines' },
  { href: '/warmup',         label: 'Calentamiento',   icon: Flame,           sector: 'warmup' },
]

const ADMIN_NAV = [
  { href: '/estadisticas', label: 'Estadísticas', icon: BarChart2, sector: 'dashboard' },
  { href: '/users',        label: 'Usuarios',     icon: UserCog,  sector: 'users' },
  { href: '/templates',    label: 'Plantillas',   icon: FileText, sector: 'templates' },
  { href: '/settings',     label: 'Ajustes',      icon: Settings, sector: 'settings' },
]

export default function Sidebar() {
  const path   = usePathname()
  const router = useRouter()
  const { user } = useCurrentUser()

  const isAdmin = user?.role === 'admin'
  const allNav = [...BASE_NAV, ...ADMIN_NAV]
  const nav = isAdmin
    ? allNav
    : allNav.filter(item => user?.sectors?.includes(item.sector))

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }
  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
      <div className="px-5 py-5 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-green-500 rounded-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">WA</span>
          </div>
          <span className="font-semibold text-sm">WA Platform</span>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = path === href
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-green-50 text-green-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <Icon size={16} />
              {label}
            </Link>
          )
        })}
      </nav>
      <div className="px-3 py-4 border-t border-gray-200 space-y-2">
        <p className="text-xs text-gray-400 px-2">v1.0 — producción</p>
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors w-full"
        >
          <LogOut size={16} /> Cerrar sesión
        </button>
      </div>
    </aside>
  )
}
