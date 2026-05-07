'use client'
import { useEffect, useRef, useState } from 'react'

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'

export function useRealTime(onUpdate: () => void): RealtimeStatus {
  const [status, setStatus]   = useState<RealtimeStatus>('connecting')
  const onUpdateRef           = useRef(onUpdate)
  onUpdateRef.current         = onUpdate

  useEffect(() => {
    let es: EventSource
    let retryTimer: ReturnType<typeof setTimeout>
    let alive = true

    const connect = () => {
      if (!alive) return
      es = new EventSource('/api/conversations/stream')

      es.onopen    = () => { if (alive) setStatus('connected') }
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as { type: string }
          if (event.type === 'update') onUpdateRef.current()
        } catch {}
      }
      es.onerror = () => {
        es.close()
        if (alive) {
          setStatus('disconnected')
          retryTimer = setTimeout(connect, 5000)
        }
      }
    }

    connect()
    return () => {
      alive = false
      clearTimeout(retryTimer)
      es?.close()
    }
  }, [])

  return status
}
