import { query } from '@/lib/db'
import { isGloballyOptedOut, withGlobalSendGuard, OPT_OUT_CANCELLED, OPT_OUT_REASON } from '@/lib/global-opt-out'
import { OptOutError } from './errors'

export async function markOptOutCancelled(messageId: string): Promise<void> {
  await query(`UPDATE cloud_messages SET status='failed',failed_at=NOW(),error_code=NULL,
    error_title=$2,error_details=$3 WHERE id=$1 AND status='queued' AND wamid IS NULL`,
  [messageId,OPT_OUT_CANCELLED,OPT_OUT_REASON])
}

export async function queuedMessageCanStart(messageId: string, phone: string): Promise<boolean> {
  const [row] = await query<{status:string;wamid:string|null}>(
    'SELECT status,wamid FROM cloud_messages WHERE id=$1', [messageId])
  if (!row || row.status !== 'queued' || row.wamid) return false
  if (await isGloballyOptedOut(phone)) {
    await markOptOutCancelled(messageId)
    return false
  }
  return true
}

// A cancelled queue item completes locally; it never enters retries or the DLQ.
// Its persistent marker survives reactivation and Redis retries/restarts.
export async function sendQueuedWithConsent<T>(messageId: string, phone: string, send: () => Promise<T>): Promise<T | null> {
  try {
    return await withGlobalSendGuard(phone, async db => {
      const {rows} = await db.query<{status:string;wamid:string|null}>(
        'SELECT status,wamid FROM cloud_messages WHERE id=$1', [messageId])
      if (rows[0]?.status !== 'queued' || rows[0]?.wamid) return null
      return send()
    })
  } catch (error) {
    if (!(error instanceof OptOutError)) throw error
    await markOptOutCancelled(messageId)
    return null
  }
}
