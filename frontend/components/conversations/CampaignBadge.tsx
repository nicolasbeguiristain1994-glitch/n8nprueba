import { Megaphone } from 'lucide-react'
import type { ConversationCampaign } from '@/lib/scoring/conversation-scoring'

export function CampaignBadge({ campaigns = [], selectedCampaign }: {
  campaigns?: ConversationCampaign[]
  selectedCampaign?: string
}) {
  const campaign = campaigns.find(item => item.id === selectedCampaign) ?? campaigns[0]
  return (
    <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground" title={
      campaign ? `Campañas: ${campaigns.map(item => item.name).join(' · ')}` : 'Sin envíos de campaña registrados'
    }>
      <Megaphone size={11} className="shrink-0" />
      <span className="truncate">{campaign?.name ?? 'Sin campaña'}</span>
      {campaigns.length > 1 && <span className="shrink-0 rounded bg-muted px-1">+{campaigns.length - 1}</span>}
    </div>
  )
}
