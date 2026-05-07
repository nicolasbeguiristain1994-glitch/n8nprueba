import { Check, CheckCheck } from 'lucide-react'
import type { Segment, Intent } from '@/lib/scoring/conversation-scoring'

// ── Segment ────────────────────────────────────────────────────────────────────

export function SegmentBadge({ segment }: { segment: Segment }) {
  if (!segment || segment === 'bajo' || segment === 'medio') return null
  if (segment === 'vip')
    return (
      <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-50 text-yellow-800 border-yellow-300 tracking-wide">
        VIP
      </span>
    )
  return (
    <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border bg-green-50 text-green-800 border-green-300 tracking-wide">
      Alto Valor
    </span>
  )
}

// ── Intent ─────────────────────────────────────────────────────────────────────

const INTENT_STYLES: Record<NonNullable<Intent>, { label: string; cls: string }> = {
  urgent:       { label: 'Urgente',      cls: 'bg-red-50 text-red-700 border-red-200' },
  complaint:    { label: 'Queja',        cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  reactivation: { label: 'Reactivación', cls: 'bg-purple-50 text-purple-700 border-purple-200' },
}

export function IntentBadge({ intent }: { intent: Intent }) {
  if (!intent) return null
  const { label, cls } = INTENT_STYLES[intent]
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  )
}

// ── Escalated ──────────────────────────────────────────────────────────────────

export function EscalatedBadge() {
  return (
    <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
      Atención
    </span>
  )
}

// ── Message delivery status ────────────────────────────────────────────────────

export function MsgStatus({ status }: { status: string }) {
  if (status === 'read')      return <CheckCheck size={12} className="text-blue-300 shrink-0" />
  if (status === 'delivered') return <CheckCheck size={12} className="text-green-100 shrink-0" />
  if (status === 'sent')      return <Check      size={12} className="text-green-100 shrink-0" />
  if (status === 'failed')    return <span className="text-[11px] text-red-300 shrink-0 font-mono">✗</span>
  return null
}
