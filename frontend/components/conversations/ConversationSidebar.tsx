'use client'
import { User, TrendingUp, Calendar } from 'lucide-react'
import type { Conv } from '@/lib/scoring/conversation-scoring'
import { SegmentBadge, IntentBadge, EscalatedBadge } from './PriorityBadge'
import { QuickActions } from './QuickActions'
import { InternalNotes } from './InternalNotes'
import { fmtPhone, displayName, detectIntent } from '@/lib/scoring/conversation-scoring'

interface Props {
  phone:      string
  conv:       Conv | undefined
  onRefresh?: () => void
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
}

export function ConversationSidebar({ phone, conv, onRefresh }: Props) {
  const days = conv ? daysSince(conv.last_at) : null

  return (
    <div className="flex flex-col h-full overflow-y-auto divide-y divide-gray-100">

      {/* Contact card */}
      <div className="px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
            <User size={14} className="text-gray-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-800 truncate">
              {conv ? displayName(conv) : fmtPhone(phone)}
            </p>
            <p className="text-[10px] text-gray-400">{fmtPhone(phone)}</p>
          </div>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-1">
          {conv?.segment && <SegmentBadge segment={conv.segment} />}
          {conv && <IntentBadge intent={detectIntent(conv.last_message, conv.last_direction)} />}
          {conv?.is_escalated && <EscalatedBadge />}
        </div>

        {/* Tags */}
        {(conv?.actividad || conv?.valor_riesgo) && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {conv.actividad && (
              <span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">
                {conv.actividad}
              </span>
            )}
            {conv.valor_riesgo && (
              <span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">
                {conv.valor_riesgo}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="px-3 py-2.5 grid grid-cols-2 gap-2">
        <div className="bg-gray-50 rounded p-2">
          <div className="flex items-center gap-1 mb-0.5">
            <Calendar size={10} className="text-gray-400" />
            <span className="text-[10px] text-gray-400">Último msj</span>
          </div>
          <p className="text-xs font-semibold text-gray-700">
            {days === null ? '—' : days === 0 ? 'Hoy' : `Hace ${days}d`}
          </p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="flex items-center gap-1 mb-0.5">
            <TrendingUp size={10} className="text-gray-400" />
            <span className="text-[10px] text-gray-400">Segmento</span>
          </div>
          <p className="text-xs font-semibold text-gray-700 capitalize">
            {conv?.segment ?? '—'}
          </p>
        </div>
      </div>

      {/* Quick actions */}
      <QuickActions phone={phone} conv={conv} onRefresh={onRefresh} />

      {/* Notes */}
      <InternalNotes phone={phone} />
    </div>
  )
}
