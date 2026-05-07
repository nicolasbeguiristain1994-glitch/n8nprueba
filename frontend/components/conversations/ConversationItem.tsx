'use client'
import { memo } from 'react'
import {
  detectIntent, displayName, initials, avatarCls, fmtTime,
  type Conv,
} from '@/lib/scoring/conversation-scoring'
import { SegmentBadge, IntentBadge, EscalatedBadge, ProcessBadge } from './PriorityBadge'

function borderColor(c: Conv, isSelected: boolean): string {
  if (isSelected)                                  return 'border-l-[3px] border-l-green-500'
  if (c.segment === 'vip')                         return 'border-l-[3px] border-l-yellow-400'
  if (c.segment === 'alto')                        return 'border-l-[3px] border-l-green-500'
  const i = detectIntent(c.last_message, c.last_direction)
  if (i === 'urgent')                              return 'border-l-[3px] border-l-red-400'
  if (i === 'complaint' || c.is_escalated)         return 'border-l-[3px] border-l-orange-400'
  if (i === 'reactivation')                        return 'border-l-[3px] border-l-purple-400'
  return 'border-l-[3px] border-l-transparent'
}

interface Props {
  conv:       Conv
  isSelected: boolean
  onClick:    () => void
}

export const ConversationItem = memo(function ConversationItem({ conv: c, isSelected, onClick }: Props) {
  const intent     = detectIntent(c.last_message, c.last_direction)
  const unread     = c.last_direction === 'inbound'
  const inProcess  = c.conv_flow === 'en_proceso'
  const hasBadge   = c.segment === 'vip' || c.segment === 'alto' || intent || c.is_escalated || inProcess

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors
        ${borderColor(c, isSelected)} ${isSelected ? 'bg-green-50' : ''}`}
    >
      <div className="flex gap-2.5 items-start">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 mt-0.5 ${avatarCls(c.segment)}`}>
          {initials(c)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-1 mb-0.5">
            <span className={`text-sm truncate ${unread ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
              {displayName(c)}
            </span>
            <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">{fmtTime(c.last_at)}</span>
          </div>

          {hasBadge && (
            <div className="flex flex-wrap gap-1 mb-1">
              <SegmentBadge segment={c.segment ?? null} />
              {inProcess && <ProcessBadge />}
              {c.is_escalated ? <EscalatedBadge /> : <IntentBadge intent={intent} />}
            </div>
          )}

          <p className={`text-xs truncate ${unread ? 'text-gray-700' : 'text-gray-400'}`}>
            {c.last_direction === 'outbound' && <span className="text-gray-300 mr-1">↑</span>}
            {c.last_message}
          </p>
        </div>

        {unread && <div className="w-2 h-2 rounded-full bg-green-500 shrink-0 mt-2" />}
      </div>
    </button>
  )
})
