'use client'
import { AgentBadge } from './AgentBadge'
import { ContactLineBadge } from './ContactLineBadge'
import { memo } from 'react'
import {
  detectIntent, displayName, initials, avatarCls, fmtTime,
  type Conv,
} from '@/lib/scoring/conversation-scoring'
import { SegmentBadge, IntentBadge, EscalatedBadge, ProcessBadge, FollowUpBadge } from './PriorityBadge'
import { CampaignBadge } from './CampaignBadge'

function borderColor(c: Conv, isSelected: boolean): string {
  if (isSelected)                                  return 'border-l-[3px] border-l-primary'
  if (c.segment === 'super_vip')                   return 'border-l-[3px] border-l-yellow-400'
  if (c.segment === 'vip_alto')                    return 'border-l-[3px] border-l-red-400'
  if (c.segment === 'vip_medio')                   return 'border-l-[3px] border-l-orange-400'
  if (c.segment === 'vip')                         return 'border-l-[3px] border-l-green-500'
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
  selectedCampaign?: string
}

export const ConversationItem = memo(function ConversationItem({ conv: c, isSelected, onClick, selectedCampaign }: Props) {
  const intent     = detectIntent(c.last_message, c.last_direction)
  const unread     = c.last_direction === 'inbound'
  const inProcess  = c.conv_flow === 'en_proceso'

  return (
    <button
      onClick={onClick}
      aria-pressed={isSelected}
      className={`w-full text-left px-3 py-2.5 border-b border-border hover:bg-background transition-colors
        ${borderColor(c, isSelected)} ${isSelected ? 'bg-accent' : ''}`}
    >
      <div className="flex gap-2.5 items-start">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 mt-0.5 ${avatarCls(c.segment)}`}>
          {initials(c)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-1 mb-0.5">
            <span className={`text-sm truncate ${unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'}`}>
              {displayName(c)}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">{fmtTime(c.last_at)}</span>
          </div>

          <div className="flex flex-wrap gap-1 mb-1">
            <SegmentBadge segment={c.segment ?? null} /><AgentBadge agent={c.agent} />
            <ContactLineBadge conv={c} />
            {inProcess && <ProcessBadge />}
            {c.has_follow_up && <FollowUpBadge />}
            {c.is_escalated ? <EscalatedBadge /> : <IntentBadge intent={intent} />}
          </div>
          <div className="mb-1"><CampaignBadge campaigns={c.campaigns} selectedCampaign={selectedCampaign} /></div>

          <p className={`text-xs truncate ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>
            {c.last_direction === 'outbound' && <span className="text-muted-foreground/60 mr-1">↑</span>}
            {c.last_message}
          </p>
        </div>

        {unread && <div className="w-2 h-2 rounded-full bg-green-500 shrink-0 mt-2" />}
      </div>
    </button>
  )
})
