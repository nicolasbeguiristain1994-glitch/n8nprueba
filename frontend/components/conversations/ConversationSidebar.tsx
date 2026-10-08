'use client'
import { User, TrendingUp, Calendar, Megaphone } from 'lucide-react'
import type { Conv } from '@/lib/scoring/conversation-scoring'
import { SegmentBadge, IntentBadge, EscalatedBadge } from './PriorityBadge'
import { QuickActions } from './QuickActions'
import { InternalNotes } from './InternalNotes'
import { fmtPhone, displayName, detectIntent, segmentLabel } from '@/lib/scoring/conversation-scoring'

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
    <div className="flex flex-col h-full overflow-y-auto divide-y divide-border">

      {/* Contact card */}
      <div className="px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
            <User size={14} className="text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">
              {conv ? displayName(conv) : fmtPhone(phone)}
            </p>
            <p className="text-xs text-muted-foreground">{fmtPhone(phone)}</p>
          </div>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-1">
          <SegmentBadge segment={conv?.segment ?? null} />
          {conv && <IntentBadge intent={detectIntent(conv.last_message, conv.last_direction)} />}
          {conv?.is_escalated && <EscalatedBadge />}
        </div>

        {/* Tags */}
        {(conv?.actividad || conv?.valor_riesgo) && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {conv.actividad && (
              <span className="text-xs bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                {conv.actividad}
              </span>
            )}
            {conv.valor_riesgo && (
              <span className="text-xs bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                {conv.valor_riesgo}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="px-3 py-2.5 grid grid-cols-2 gap-2">
        <div className="bg-background rounded-lg border border-border p-2.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Calendar size={10} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Último msj</span>
          </div>
          <p className="text-xs font-semibold text-foreground">
            {days === null ? '—' : days === 0 ? 'Hoy' : `Hace ${days}d`}
          </p>
        </div>
        <div className="bg-background rounded-lg border border-border p-2.5">
          <div className="flex items-center gap-1 mb-0.5">
            <TrendingUp size={10} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Nivel</span>
          </div>
          <p className="text-xs font-semibold text-foreground">
            {segmentLabel(conv?.segment)}
          </p>
        </div>
      </div>

      <div className="px-3 py-3 space-y-2">
        <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Megaphone size={11} /> Campañas</p>
        {conv?.campaigns?.length ? conv.campaigns.map((campaign, index) => (
          <div key={campaign.id} className="rounded-lg border border-border bg-background p-3">
            <p className="break-words text-xs font-medium">{campaign.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {index === 0 ? 'Última · ' : ''}{new Date(campaign.last_sent_at).toLocaleDateString('es-AR')}
            </p>
          </div>
        )) : <p className="text-xs text-muted-foreground">Sin campaña</p>}
      </div>

      {/* Quick actions */}
      <QuickActions phone={phone} conv={conv} onRefresh={onRefresh} />

      {/* Notes */}
      <InternalNotes phone={phone} />
    </div>
  )
}
