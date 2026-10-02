import { LayoutDashboard, Users, Megaphone, MessageSquare, Activity, UserCog, Settings, FileText, BarChart2, ShieldOff, Bot, ClipboardList, CheckSquare, CalendarDays, TrendingUp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  sector: string
}

export const BASE_NAV: NavItem[] = [
  { href: '/',               label: 'Dashboard',       icon: LayoutDashboard, sector: 'dashboard' },
  { href: '/contacts',       label: 'Contactos',        icon: Users,           sector: 'contacts' },
  { href: '/prioridades',    label: 'Prioridades',      icon: TrendingUp,      sector: 'contacts' },
  { href: '/campaigns',      label: 'Campañas',         icon: Megaphone,       sector: 'campaigns' },
  { href: '/conversations',  label: 'Conversaciones',   icon: MessageSquare,   sector: 'conversations' },
  { href: '/lines',          label: 'Líneas',           icon: Activity,        sector: 'lines' },
  { href: '/mis-tareas',     label: 'Mis Tareas',       icon: CheckSquare,     sector: 'tasks' },
  { href: '/calendario',     label: 'Calendario',       icon: CalendarDays,    sector: 'tasks' },
  { href: '/estadisticas',   label: 'Estadísticas',     icon: BarChart2,       sector: 'estadisticas' },
  { href: '/automatizaciones',label: 'Automatizaciones',icon: Bot,             sector: 'automations' },
  { href: '/blacklist',      label: 'Blacklist',        icon: ShieldOff,       sector: 'blacklist' },
  { href: '/templates',      label: 'Plantillas',       icon: FileText,        sector: 'templates' },
]

export const ADMIN_NAV: NavItem[] = [
  { href: '/tareas',    label: 'Tareas',    icon: ClipboardList, sector: 'tasks' },
  { href: '/users',     label: 'Usuarios',  icon: UserCog,       sector: 'users' },
  { href: '/settings',  label: 'Ajustes',   icon: Settings,      sector: 'settings' },
]


export const NAV_GROUPS = [
  { label: 'Espacio de trabajo', paths: ['/', '/mis-tareas', '/calendario'] },
  { label: 'Clientes y campañas', paths: ['/contacts', '/prioridades', '/campaigns', '/conversations', '/templates'] },
  { label: 'Operaciones', paths: ['/lines', '/automatizaciones', '/estadisticas', '/blacklist'] },
  { label: 'Administración', paths: ['/tareas', '/users', '/settings'] },
]

export function routeLabel(pathname: string) {
  if (pathname === '/ayuda') return 'Guía de uso'
  return [...BASE_NAV, ...ADMIN_NAV].find(item => item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(item.href + '/'))?.label ?? 'Espacio de trabajo'
}
