'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

export function useDesktopNotifications() {
  // Match the server's initial render; browser permission is read after hydration.
  const [permission, setPermission] = useState<NotificationPermission>('default')

  // Grace period: ignore SSE events during first 3s to avoid spam on page load
  const mountedAt = useRef(Date.now())

  useEffect(() => {
    if (!('Notification' in window)) { setPermission('denied'); return }
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
