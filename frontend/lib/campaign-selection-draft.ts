import { BroadcastPlanOptionsSchema } from './broadcast-plan-schema'
import type { BroadcastCampaignDraft } from './broadcast-plan-selection'
import { CAMPAIGN_SELECTION_LIMIT } from './campaign-selection'
const PREFIX = 'wa:campaign-selection:'
const MAX_AGE = 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface CampaignSelectionDraft { owner: string; contactIds: string[]; createdAt: number; broadcastPlan?: BroadcastCampaignDraft }

export function saveCampaignSelection(owner: string, ids: string[], storage = sessionStorage, broadcastPlan?: BroadcastCampaignDraft): string {
  const contactIds = [...new Set(ids)]
  if (!owner || !contactIds.length || contactIds.length > CAMPAIGN_SELECTION_LIMIT || contactIds.some(id => !UUID.test(id))) {
    throw new Error('Revisá los contactos seleccionados antes de crear la campaña.')
  }
  // Contact IDs and optional plan settings only, scoped to this tab and signed-in account.
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(PREFIX)) continue
    try { if (Date.now() - JSON.parse(storage.getItem(key)!).createdAt > MAX_AGE) storage.removeItem(key) } catch { storage.removeItem(key) }
  }
  const token = crypto.randomUUID()
  storage.setItem(PREFIX + token, JSON.stringify({ owner, contactIds, createdAt: Date.now(), broadcastPlan }))
  return token
}
export function readCampaignSelection(token: string, owner: string, storage = sessionStorage): CampaignSelectionDraft | null {
  if (!UUID.test(token)) return null
  try {
    const draft = JSON.parse(storage.getItem(PREFIX + token) || 'null') as CampaignSelectionDraft | null
    if (!draft || draft.owner !== owner || !Number.isFinite(draft.createdAt) || Date.now() - draft.createdAt > MAX_AGE
      || !Array.isArray(draft.contactIds) || !draft.contactIds.length || draft.contactIds.length > CAMPAIGN_SELECTION_LIMIT
      || draft.contactIds.some(id => typeof id !== 'string' || !UUID.test(id))) return null
    if (draft.broadcastPlan) {
      const plan=draft.broadcastPlan, ids=new Set(draft.contactIds)
      if (!UUID.test(plan.requestId) || !/^[a-f0-9]{64}$/.test(plan.fingerprint) ||
          !BroadcastPlanOptionsSchema.safeParse(plan.options).success || !Number.isFinite(Date.parse(plan.startsAt)) ||
          !Number.isFinite(Date.parse(plan.endsAt)) || !Array.isArray(plan.lines) || !Array.isArray(plan.recipients) ||
          plan.recipients.length !== draft.contactIds.length || plan.recipients.some(c => !UUID.test(c.id) || !UUID.test(c.lineId) || !ids.has(c.id)) ||
          plan.lines.some(l => !UUID.test(l.id) || typeof l.name !== 'string' || !Number.isInteger(l.selected) || l.selected < 1)) return null
    }
    return { ...draft, contactIds: [...new Set(draft.contactIds)] }
  } catch { return null }
}
export function clearCampaignSelection(token: string | null, storage = sessionStorage) {
  if (token && UUID.test(token)) storage.removeItem(PREFIX + token)
}
