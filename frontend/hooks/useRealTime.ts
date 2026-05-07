'use client'
import { useEffect, useRef, useState } from 'react'

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'
export type SseEvent = { type: string; source?: string; phone?: string }

export function useRealTime(onUpdate: (event: SseEvent) => void): RealtimeStatus {
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
          const event = JSON.parse(e.data) as SseEvent
          if (event.type === 'update') onUpdateRef.current(event)
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
