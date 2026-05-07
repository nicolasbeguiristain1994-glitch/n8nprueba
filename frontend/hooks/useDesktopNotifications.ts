'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

export function useDesktopNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
    return Notification.permission
  })

  // Grace period: ignore SSE events during first 3s to avoid spam on page load
  const mountedAt = useRef(Date.now())

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    // Sync in case permission changed externally (e.g. browser settings)
    setPermission(Notification.permission)
  }, [])

  const request = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'denied') return
    const p = await Notification.requestPermission()
    setPermission(p)
  }, [])

  const notify = useCallback((title: string, body: string, onClick?: () => void) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (permission !== 'granted') return
    if (Date.now() - mountedAt.current < 3000) return
    try {
      const n = new Notification(title, { body, icon: '/favicon.ico' })
      n.onclick = () => { window.focus(); n.close(); onClick?.() }
    } catch {}
  }, [permission])

  return { permission, notify, request }
}
