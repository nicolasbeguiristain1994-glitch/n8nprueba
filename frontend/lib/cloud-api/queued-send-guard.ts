import { query } from '@/lib/db'
import { isGloballyOptedOut, withGlobalSendGuard, OPT_OUT_CANCELLED, OPT_OUT_REASON } from '@/lib/global-opt-out'
import { OptOutError } from './errors'

export async function markOptOutCancelled(messageId: string): Promise<void> {
  await query(`UPDATE cloud_messages SET status='failed',failed_at=NOW(),error_code=NULL,
    error_title=$2,error_details=$3 WHERE id=$1 AND status='queued' AND wamid IS NULL`,
  [messageId,OPT_OUT_CANCELLED,OPT_OUT_REASON])
}

async function queuedContext(messageId:string) {
  const [row]=await query<{phone_number_id:string;campaign_id:string|null;agent_code:string|null}>(
    "SELECT phone_number_id,campaign_id,content->>'agentCode' AS agent_code FROM cloud_messages WHERE id=$1",[messageId])
  return {provider:'cloud' as const,sourceId:row?.phone_number_id,campaignId:row?.campaign_id,agentCode:row?.agent_code}
}

export async function queuedMessageCanStart(messageId: string, phone: string): Promise<boolean> {
  const [row] = await query<{status:string;wamid:string|null}>(
    'SELECT status,wamid FROM cloud_messages WHERE id=$1', [messageId])
  if (!row || row.status !== 'queued' || row.wamid) return false
  if (await isGloballyOptedOut(phone,await queuedContext(messageId))) {
    await markOptOutCancelled(messageId)
    return false
  }
  return true
}

// A cancelled queue item completes locally; it never enters retries or the DLQ.
// Its persistent marker survives reactivation and Redis retries/restarts.
export async function sendQueuedWithConsent<T>(messageId: string, phone: string, send: () => Promise<T>): Promise<T | null> {
  try {
    const context=await queuedContext(messageId)
    return await withGlobalSendGuard(phone, async db => {
      const {rows} = await db.query<{status:string;wamid:string|null}>(
        'SELECT status,wamid FROM cloud_messages WHERE id=$1', [messageId])
      if (rows[0]?.status !== 'queued' || rows[0]?.wamid) return null
      return send()
    },context)
  } catch (error) {
    if (!(error instanceof OptOutError)) throw error
    await markOptOutCancelled(messageId)
    return null
  }
}
