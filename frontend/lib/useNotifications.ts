'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

export interface Notification {
  id: string
  type: string
  title: string
  body: string | null
  link: string | null
  related_type: string | null
  related_id: string | null
  is_read: boolean
  read_at: string | null
  created_at: string
}

interface State {
  notifications: Notification[]
  unread: number
  loading: boolean
  error: string | null
}

const POLL_MS = 30_000  // polling cada 30 segundos

export function useNotifications() {
  const [state, setState] = useState<State>({
    notifications: [],
    unread: 0,
    loading: true,
    error: null,
  })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=30')
      if (!res.ok) throw new Error('Error al cargar notificaciones')
      const data = await res.json() as { notifications: Notification[]; unread: number }
      setState(s => ({ ...s, notifications: data.notifications, unread: data.unread, loading: false, error: null }))
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : 'Error desconocido' }))
    }
  }, [])

  // Polling
  useEffect(() => {
    fetchNotifications()

    intervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') fetchNotifications()
    }, POLL_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchNotifications])

  const markRead = useCallback(async (ids: string[]) => {
    // Optimistic update
    setState(s => ({
      ...s,
      notifications: s.notifications.map(n =>
        ids.includes(n.id) ? { ...n, is_read: true } : n
      ),
      unread: Math.max(0, s.unread - ids.filter(id =>
        s.notifications.find(n => n.id === id && !n.is_read)
      ).length),
    }))

    try {
      await fetch('/api/notifications/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    } catch {
      // Revertir en caso de error
      fetchNotifications()
    }
  }, [fetchNotifications])

  const markAllRead = useCallback(async () => {
    // Optimistic update
    setState(s => ({
      ...s,
      notifications: s.notifications.map(n => ({ ...n, is_read: true })),
      unread: 0,
    }))

    try {
      await fetch('/api/notifications/mark-all-read', { method: 'POST' })
    } catch {
      fetchNotifications()
    }
  }, [fetchNotifications])

  return {
    ...state,
    refresh: fetchNotifications,
    markRead,
    markAllRead,
  }
}
