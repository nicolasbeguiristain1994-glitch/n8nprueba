'use client'

import { createContext, createElement, useContext, useState, useEffect, type ReactNode } from 'react'
import type { EffectivePermissions } from '@/lib/permissions'

export type CurrentUser = {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'operator' | 'viewer'
  sectors: string[]
  can_download_contacts: boolean
  allowed_agents: string[]
}

export type UseCurrentUserResult = {
  user: CurrentUser | null
  permissions: EffectivePermissions
  loading: boolean
  error: string | null
}

const CurrentUserContext = createContext<UseCurrentUserResult | null>(null)
const INITIAL_STATE: UseCurrentUserResult = { user: null, permissions: {}, loading: true, error: null }

function useCurrentUserRequest(enabled: boolean, refreshKey = ''): UseCurrentUserResult {
  const [state, setState] = useState<UseCurrentUserResult>(INITIAL_STATE)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let pending = false
    let checkedAt = 0
    let controller: AbortController | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined

    const refresh = async () => {
      if (pending || disposed) return
      pending = true
      controller = new AbortController()
      deadline = setTimeout(() => controller?.abort(), 15_000)
      try {
        const res = await fetch('/api/auth/me', { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json() as { user: CurrentUser; permissions: EffectivePermissions }
        if (!disposed) setState({ user: data.user, permissions: data.permissions ?? {}, loading: false, error: null })
      } catch (error) {
        // A revoked/expired session must clear permissions in every consumer.
        if (!disposed) setState({ user: null, permissions: {}, loading: false, error: error instanceof Error && /^\d{3}$/.test(error.message) ? error.message : 'network' })
      } finally {
        clearTimeout(deadline)
        pending = false
        checkedAt = Date.now()
      }
    }
    const onVisible = () => {
      if (!document.hidden && Date.now() - checkedAt > 5_000) void refresh()
    }
    void refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      disposed = true
      controller?.abort()
      clearTimeout(deadline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refreshKey])

  return state
}

// One request for the whole authenticated layout, revalidated on navigation.
// State belongs to this mount: it never survives logout or crosses sessions.
export function CurrentUserProvider({ children, refreshKey }: { children: ReactNode; refreshKey: string }) {
  const value = useCurrentUserRequest(true, refreshKey)
  return createElement(CurrentUserContext.Provider, { value }, children)
}

export function useCurrentUser(): UseCurrentUserResult {
  const shared = useContext(CurrentUserContext)
  const standalone = useCurrentUserRequest(shared === null)
  return shared ?? standalone
}
