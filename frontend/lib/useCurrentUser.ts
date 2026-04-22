'use client'

import { useState, useEffect } from 'react'
import type { EffectivePermissions } from '@/lib/permissions'

export type CurrentUser = {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'operator' | 'viewer'
  sectors: string[]
}

export type UseCurrentUserResult = {
  user: CurrentUser | null
  permissions: EffectivePermissions
  loading: boolean
  error: string | null
}

/**
 * Fetch /api/auth/me and return the current user + effective permissions.
 *
 * Returns { loading: true } while the request is in flight.
 * Returns { error } on 401/403 or network failure — caller decides how to handle.
 * Never throws.
 */
export function useCurrentUser(): UseCurrentUserResult {
  const [user, setUser]             = useState<CurrentUser | null>(null)
  const [permissions, setPerms]     = useState<EffectivePermissions>({})
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/auth/me')
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          setError(`${res.status}`)
          setLoading(false)
          return
        }
        const data = await res.json() as { user: CurrentUser; permissions: EffectivePermissions }
        if (cancelled) return
        setUser(data.user)
        setPerms(data.permissions ?? {})
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setError('network')
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  return { user, permissions, loading, error }
}
