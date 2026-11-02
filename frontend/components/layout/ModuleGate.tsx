'use client'
import { useEffect, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { BASE_NAV, ADMIN_NAV } from './navigation'
import type { Resource } from '@/lib/permissions'

export function ModuleGate({ children }: { children: ReactNode }) {
  const { user, permissions, loading, error } = useCurrentUser()
  const pathname = usePathname()
  const router = useRouter()
  const routes = [...BASE_NAV, ...ADMIN_NAV]
  const current = routes.find(item => item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(item.href + '/'))
  const allowed = user && (!current || permissions[current.sector as Resource]?.includes('read'))
  const home = routes.find(item => permissions[item.sector as Resource]?.includes('read'))?.href
  useEffect(() => {
    if (loading) return
    if (error === '401') router.replace('/login')
    else if (user && !allowed && home && home !== pathname) router.replace(home)
  }, [loading, error, user, allowed, home, pathname, router])
  if (loading) return <p role="status" className="p-6">Cargando permisos…</p>
  if (!allowed) return <p role="alert" className="p-6">No tenés acceso a este módulo.</p>
  return children
}
