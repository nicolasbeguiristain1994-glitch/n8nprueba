'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Users, Megaphone, MessageSquare, Activity, Flame } from 'lucide-react'

const nav = [
  { href: '/',               label: 'Dashboard',      icon: LayoutDashboard },
  { href: '/contacts',       label: 'Contactos',       icon: Users },
  { href: '/campaigns',      label: 'Campañas',        icon: Megaphone },
  { href: '/conversations',  label: 'Conversaciones',  icon: MessageSquare },
  { href: '/lines',          label: 'Líneas',          icon: Activity },
  { href: '/warmup',         label: 'Calentamiento',   icon: Flame },
]

export default function Sidebar() {
  const path = usePathname()
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
      <div className="px-5 py-4 border-t border-gray-200">
        <p className="text-xs text-gray-400">v1.0 — producción</p>
      </div>
    </aside>
  )
}
