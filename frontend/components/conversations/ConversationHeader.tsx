import { AgentBadge } from './AgentBadge'
import { ContactLineBadge } from './ContactLineBadge'
import { AlertCircle, UserPlus } from 'lucide-react'
import { displayName, fmtPhone, avatarCls, initials, type Conv } from '@/lib/scoring/conversation-scoring'
import { SegmentBadge } from './PriorityBadge'
import { CampaignBadge } from './CampaignBadge'

interface Props {
  phone: string
  conv:  Conv | undefined
  selectedCampaign?: string
}

export function ConversationHeader({ phone, conv, selectedCampaign }: Props) {
  return (
    <div className="border-b border-border bg-card px-3 py-2 md:px-4 md:py-4 flex items-center gap-2 md:gap-3 shrink-0">
      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${avatarCls(conv?.segment)}`}>
        {conv ? initials(conv) : phone.slice(-2)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="truncate text-sm font-semibold">{conv ? displayName(conv) : fmtPhone(phone)}</p>
          <span className="hidden md:contents"><SegmentBadge segment={conv?.segment ?? null} /><AgentBadge agent={conv?.agent} />
          <ContactLineBadge conv={conv} />
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-xs text-muted-foreground font-mono">{fmtPhone(phone)}</p>
          {conv?.actividad && (
            <span className="hidden md:inline text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5">
              {conv.actividad}
            </span>
          )}
          {conv?.valor_riesgo && (
            <span className="hidden md:inline text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5">
              {conv.valor_riesgo}
            </span>
          )}
        </div>
        {conv && <div className="hidden md:block mt-1"><CampaignBadge campaigns={conv.campaigns} selectedCampaign={selectedCampaign} /></div>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!conv?.contact_id && (
          <a
            href={`/contacts?phone=${phone}`}
            className="flex items-center gap-1 text-xs text-primary hover:text-accent-foreground bg-accent border border-primary/20 rounded-full px-2.5 py-1 whitespace-nowrap"
          >
            <UserPlus size={11} /> Crear contacto
          </a>
        )}
        {conv?.is_escalated && (
          <span className="flex items-center gap-1 text-xs text-warning bg-warning/10 border border-warning/20 rounded-full px-2 py-0.5">
            <AlertCircle size={11} /> Atención
          </span>
        )}
      </div>
    </div>
  )
}
