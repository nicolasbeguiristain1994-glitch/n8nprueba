import { CAMPAIGN_SELECTION_LIMIT } from './campaign-selection'
const PREFIX = 'wa:campaign-selection:'
const MAX_AGE = 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface CampaignSelectionDraft { owner: string; contactIds: string[]; createdAt: number }

export function saveCampaignSelection(owner: string, ids: string[], storage = sessionStorage): string {
  const contactIds = [...new Set(ids)]
  if (!owner || !contactIds.length || contactIds.length > CAMPAIGN_SELECTION_LIMIT || contactIds.some(id => !UUID.test(id))) {
    throw new Error('Revisá los contactos seleccionados antes de crear la campaña.')
  }
  // Only IDs are kept, scoped to this tab and the signed-in account.
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(PREFIX)) continue
    try { if (Date.now() - JSON.parse(storage.getItem(key)!).createdAt > MAX_AGE) storage.removeItem(key) } catch { storage.removeItem(key) }
  }
  const token = crypto.randomUUID()
  storage.setItem(PREFIX + token, JSON.stringify({ owner, contactIds, createdAt: Date.now() }))
  return token
}
export function readCampaignSelection(token: string, owner: string, storage = sessionStorage): CampaignSelectionDraft | null {
  if (!UUID.test(token)) return null
  try {
    const draft = JSON.parse(storage.getItem(PREFIX + token) || 'null') as CampaignSelectionDraft | null
    if (!draft || draft.owner !== owner || !Number.isFinite(draft.createdAt) || Date.now() - draft.createdAt > MAX_AGE
      || !Array.isArray(draft.contactIds) || !draft.contactIds.length || draft.contactIds.length > CAMPAIGN_SELECTION_LIMIT
      || draft.contactIds.some(id => typeof id !== 'string' || !UUID.test(id))) return null
    return { ...draft, contactIds: [...new Set(draft.contactIds)] }
  } catch { return null }
}
export function clearCampaignSelection(token: string | null, storage = sessionStorage) {
  if (token && UUID.test(token)) storage.removeItem(PREFIX + token)
}
