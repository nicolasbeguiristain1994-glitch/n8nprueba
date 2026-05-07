'use client'
import { useEffect, useRef, useState } from 'react'
import type { RealtimeStatus } from './useRealTime'

export function useWarmupRealtime(onNumbers: (numbers: unknown[]) => void): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const cbRef = useRef(onNumbers)
  cbRef.current = onNumbers

  useEffect(() => {
    let es: EventSource
    let retryTimer: ReturnType<typeof setTimeout>
    let alive = true

    const connect = () => {
      if (!alive) return
      es = new EventSource('/api/warmup/stream')

      es.onopen = () => { if (alive) setStatus('connected') }

      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as { type: string; numbers?: unknown[] }
          if (ev.type === 'warmup-update' && Array.isArray(ev.numbers))
            cbRef.current(ev.numbers)
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
