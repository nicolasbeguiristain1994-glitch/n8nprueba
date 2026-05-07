'use client'
import { useState, useCallback } from 'react'
import { X, AlertTriangle, CheckCircle2, Clock, Info } from 'lucide-react'

export type ToastVariant = 'critical' | 'warning' | 'success' | 'info'

export interface WarmupToastItem {
  id:      string
  variant: ToastVariant
  title:   string
  body?:   string
}

const VARIANT_CLS: Record<ToastVariant, string> = {
  critical: 'border-red-200 bg-red-50',
  warning:  'border-amber-200 bg-amber-50',
  success:  'border-green-200 bg-green-50',
  info:     'border-blue-200 bg-blue-50',
}

const VARIANT_ICON: Record<ToastVariant, React.ReactNode> = {
  critical: <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />,
  warning:  <Clock         size={14} className="text-amber-500 shrink-0 mt-0.5" />,
  success:  <CheckCircle2  size={14} className="text-green-500 shrink-0 mt-0.5" />,
  info:     <Info          size={14} className="text-blue-500 shrink-0 mt-0.5" />,
}

// ── Toast stack renderer ────────────────────────────────────────────────────────
interface StackProps {
  toasts:   WarmupToastItem[]
  onDismiss:(id: string) => void
}

export function WarmupToastStack({ toasts, onDismiss }: StackProps) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-16 right-5 z-50 flex flex-col gap-2 w-72 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 rounded-lg border shadow-lg text-sm ${VARIANT_CLS[t.variant]}`}
        >
          {VARIANT_ICON[t.variant]}
          <div className="flex-1 min-w-0">
            <p className="font-medium text-gray-800 text-xs leading-snug">{t.title}</p>
            {t.body && <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{t.body}</p>}
          </div>
          <button
            onClick={() => onDismiss(t.id)}
            className="shrink-0 text-gray-400 hover:text-gray-600 -mt-0.5 ml-1"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Hook ────────────────────────────────────────────────────────────────────────
let _counter = 0

export function useWarmupToasts() {
  const [toasts, setToasts] = useState<WarmupToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const push = useCallback((variant: ToastVariant, title: string, body?: string) => {
    const id = `wt-${++_counter}`
    setToasts(prev => [...prev.slice(-4), { id, variant, title, body }])
    setTimeout(() => dismiss(id), 6000)
  }, [dismiss])

  return { toasts, push, dismiss }
}
