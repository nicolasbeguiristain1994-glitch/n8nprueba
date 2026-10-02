import { query } from './db'
import { isOwnerOrAdmin } from './permissions'
import type { SessionUser } from './auth'

/** Recheck list ownership when starting, including lists transferred since draft creation. */
export async function campaignAudienceError(user: SessionUser, campaign: {list_id?: string | null; prospect_list_id?: string | null}) {
  if (!!campaign.list_id === !!campaign.prospect_list_id) return {status:400,error:'Seleccioná una lista de contactos o de difusión'}
  const table = campaign.list_id ? 'contact_lists' : 'prospect_lists'
  const [list] = await query<{owned_by:string|null}>(`SELECT owned_by FROM ${table} WHERE id=$1`,[campaign.list_id || campaign.prospect_list_id])
  if (!list) return {status:404,error:'La lista de la campaña ya no existe'}
  if (!isOwnerOrAdmin(user,list.owned_by)) return {status:403,error:'Ya no tenés acceso a la lista de esta campaña'}
  return null
}
