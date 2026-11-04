import { canonicalAgent } from './agent-scope'
import type { BroadcastPlan, BroadcastPlanOptions } from './broadcast-planner'
import type { BroadcastPlanningOptions } from './broadcast-plan-repository'

export function lineCompatibility(line: BroadcastPlanningOptions['lines'][number], form: Pick<BroadcastPlanOptions,'messageType'|'templateId'>, templates: BroadcastPlanningOptions['templates']): string | null {
  if (line.unavailableReason) return line.unavailableReason
  if (form.messageType === 'text') return line.type === 'evolution' ? null : 'Para Cloud elegí una plantilla'
  if (line.type !== 'cloud') return 'Las plantillas se envían por Cloud'
  const template = templates.find(t => t.id === form.templateId)
  if (!template) return 'Elegí una plantilla'
  return line.wabaId === template.wabaId ? null : 'Pertenece a otra cuenta de WhatsApp'
}
export interface BroadcastCampaignDraft {
  requestId: string
  agentKey?: string | null
  fingerprint: string
  options: BroadcastPlanOptions
  startsAt: string
  endsAt: string
  recipients: {id:string;lineId:string}[]
  lines: {id:string;name:string;selected:number}[]
}
export function campaignDraftFromPlan(plan: BroadcastPlan, options: BroadcastPlanOptions, requestId = crypto.randomUUID()): BroadcastCampaignDraft {
  if (!plan.fingerprint || !plan.selected) throw Error('Actualizá el plan antes de crear la campaña.')
  const agents = [...new Set(plan.contacts.filter(c=>!c.reason).map(c=>c.agent ? canonicalAgent(c.agent) : null))]
  return {requestId,agentKey:agents.length===1 ? agents[0] : null,fingerprint:plan.fingerprint,options:{...options,planDate:plan.planDate},startsAt:plan.startsAt,endsAt:plan.endsAt,
    recipients:plan.contacts.filter(c=>!c.reason).map(c=>({id:c.id,lineId:c.lineId!})),
    lines:plan.lines.filter(l => l.selected>0).map(({id,name,selected}) => ({id,name,selected}))}
}
