import { Check, CheckCheck } from 'lucide-react'
import type { Segment, Intent } from '@/lib/scoring/conversation-scoring'

// ── Segment ────────────────────────────────────────────────────────────────────

export function SegmentBadge({ segment }: { segment: Segment }) {
  if (!segment || segment === 'bajo' || segment === 'medio') return null
  if (segment === 'super_vip')
    return (
      <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border bg-purple-50 text-purple-800 border-purple-300 tracking-wide">
        Super Vip
      </span>
    )
  return (
    <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-50 text-yellow-800 border-yellow-300 tracking-wide">
      Vip
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

// ── En Proceso ────────────────────────────────────────────────────────────────

export function ProcessBadge() {
  return (
    <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-blue-50 text-blue-700 border-blue-200">
      En Proceso
    </span>
  )
}

// ── Follow-up ─────────────────────────────────────────────────────────────────

export function FollowUpBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-sky-50 text-sky-700 border-sky-200">
      📅 Seguimiento
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
