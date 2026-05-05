'use client'

import { useCallback, useRef, useState } from 'react'

interface ToastState {
  visible: boolean
  message: string
}

interface UseToastReturn {
  toast: ToastState
  showToast: (message: string) => void
}

export function useToast(): UseToastReturn {
  const [toast, setToast] = useState<ToastState>({ visible: false, message: '' })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((message: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setToast({ visible: true, message })
    timerRef.current = setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }))
    }, 2500)
  }, [])

  return { toast, showToast }
}
