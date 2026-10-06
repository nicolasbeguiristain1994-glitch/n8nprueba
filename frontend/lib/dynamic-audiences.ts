import { query, withTransaction } from './db'
import { resolvedContactFilters, ContactFilterError } from './contact-filters'
import { contactScope, type ContactAccessUser } from './contact-visibility'

const KEYS = new Set(['q','segment','gaming','panel','linea','linea_sub','actividad','antiguedad','plataforma','sin_movimiento','tag','inactividad_desde','inactividad_hasta','movimiento_modo','calidad','depositos_recientes','difusion','difusion_dias','difusion_desde','difusion_hasta'])
export function savedAudienceParams(value: unknown): URLSearchParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContactFilterError('Filtros de audiencia inválidos')
  const result = new URLSearchParams()
  for (const [key, v] of Object.entries(value)) {
    if (key === 'list_id' && v) throw new ContactFilterError('Quitá el filtro de lista antes de guardar una audiencia dinámica')
    if (v === '' || v === false || v === null || v === undefined || key === 'list_id') continue
    if (!KEYS.has(key) || !['string','boolean'].includes(typeof v)) throw new ContactFilterError('Filtro de audiencia no permitido')
    if (String(v).length > 1000) throw new ContactFilterError('Filtro demasiado largo')
    result.set(key,String(v))
  }
  return result
}

export async function resolveSavedAudience(filters: unknown, user: ContactAccessUser) {
  const params = savedAudienceParams(filters)
  const audience = await resolvedContactFilters(params,user)
  const rows = await query<{id:string}>(`SELECT id FROM contacts WHERE ${audience.sql} ORDER BY id LIMIT 100001`,audience.params)
  if (rows.length>100000) throw new ContactFilterError('La audiencia supera 100.000 contactos. Acotá los filtros.')
  return rows.map(r=>r.id)
}

/** Freeze dynamic membership once per campaign, including an empty audience.
 * Resuming/retrying a campaign never adds newly matching people. */
export async function ensureCampaignAudienceSnapshot(campaignId:string,listId:string):Promise<void> {
  const [campaign] = await query<{owned_by:string|null;is_dynamic:boolean;filters:unknown;list_owner:string|null;audience_snapshot_at:string|null}>(
    `SELECT c.owned_by,c.audience_snapshot_at,l.is_dynamic,l.filters,l.owned_by list_owner
     FROM campaigns c JOIN contact_lists l ON l.id=c.list_id WHERE c.id=$1 AND l.id=$2`,[campaignId,listId])
  if (!campaign) throw new Error('La campaña cambió de audiencia')
  if (!campaign.is_dynamic || campaign.audience_snapshot_at) return
  const [owner] = await query<ContactAccessUser & {is_active:boolean}>('SELECT id AS user_id,role,allowed_agents,is_active FROM users WHERE id=$1',[campaign.owned_by])
  if (!owner?.is_active || (owner.role!=='admin' && campaign.list_owner!==owner.user_id)) throw new Error('El responsable ya no tiene acceso a la audiencia')
  const ids = await resolveSavedAudience(campaign.filters,owner)
  await withTransaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('campaign-audience:' || $1,0))",[campaignId])
    const {rows:[locked]} = await client.query(`SELECT c.audience_snapshot_at,l.filters,l.owned_by list_owner
      FROM campaigns c JOIN contact_lists l ON l.id=c.list_id WHERE c.id=$1 AND l.id=$2 FOR UPDATE OF c,l`,[campaignId,listId])
    if (!locked) throw new Error('La campaña cambió de audiencia')
    if (locked.audience_snapshot_at) return
    const {rows:[started]} = await client.query('SELECT 1 FROM campaign_recipients WHERE campaign_id=$1 LIMIT 1',[campaignId])
    if (started) throw new Error('Esta campaña ya tiene destinatarios. Creá otra para actualizar la audiencia dinámica.')
    if (JSON.stringify(locked.filters)!==JSON.stringify(campaign.filters) || locked.list_owner!==campaign.list_owner) throw new Error('La audiencia cambió. Volvé a preparar la campaña.')
    const scope=contactScope(owner,2)
    await client.query(`INSERT INTO campaign_audience_members(campaign_id,contact_id)
      SELECT $1,id FROM contacts WHERE id=ANY($2::uuid[]) AND ${scope.sql} ON CONFLICT DO NOTHING`,[campaignId,ids,...scope.params])
    await client.query('DELETE FROM contact_list_members WHERE list_id=$1',[listId])
    await client.query('INSERT INTO contact_list_members(list_id,contact_id) SELECT $1,contact_id FROM campaign_audience_members WHERE campaign_id=$2',[listId,campaignId])
    await client.query('UPDATE contact_lists SET refreshed_at=NOW() WHERE id=$1',[listId])
    await client.query('UPDATE campaigns SET audience_snapshot_at=NOW() WHERE id=$1',[campaignId])
  })
}

export const campaignMembershipSQL = `SELECT contact_id FROM campaign_audience_members WHERE campaign_id=$1
  UNION ALL SELECT contact_id FROM contact_list_members WHERE list_id=$2
    AND NOT EXISTS(SELECT 1 FROM campaigns WHERE id=$1 AND audience_snapshot_at IS NOT NULL)`
