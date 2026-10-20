import { query } from '@/lib/db'
import { isGloballyOptedOut, withGlobalSendGuard, OPT_OUT_CANCELLED, OPT_OUT_REASON } from '@/lib/global-opt-out'
import { CampaignRiskError, assertCloudSendRiskClear, recordCampaignProviderRisk, CAMPAIGN_RISK_CLEAR_SQL } from '@/lib/campaign-risk'
import { refreshCampaignMetaRisk } from './meta-risk-refresh'
import { CloudApiError, OptOutError } from './errors'

export async function markOptOutCancelled(messageId: string): Promise<void> {
  await query(`UPDATE cloud_messages SET status='failed',failed_at=NOW(),error_code=NULL,
    error_title=$2,error_details=$3 WHERE id=$1 AND status='queued' AND wamid IS NULL`,
  [messageId,OPT_OUT_CANCELLED,OPT_OUT_REASON])
}

export async function markRiskCancelled(messageId: string): Promise<void> {
  await query(`UPDATE cloud_messages SET status='failed',failed_at=NOW(),error_code=NULL,
    error_title='risk-guard-no-send',error_details='Envío detenido por una alerta de riesgo; no se contactó al proveedor'
    WHERE id=$1 AND status='queued' AND wamid IS NULL`, [messageId])
}

async function queuedContext(messageId:string) {
  const [row]=await query<{phone_number_id:string;campaign_id:string|null;agent_code:string|null;template_name:string|null}>(
    "SELECT phone_number_id,campaign_id,content->>'agentCode' AS agent_code,content->'template'->>'name' AS template_name FROM cloud_messages WHERE id=$1",[messageId])
  return {provider:'cloud' as const,sourceId:row?.phone_number_id,campaignId:row?.campaign_id,agentCode:row?.agent_code,templateName:row?.template_name??undefined}
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
  let providerStarted = false
  let context: Awaited<ReturnType<typeof queuedContext>> | undefined
  try {
    context = await queuedContext(messageId)
    if (!context.sourceId) throw new CampaignRiskError('No se pudo identificar la línea del mensaje pendiente.')
    if (context.campaignId) await refreshCampaignMetaRisk(context.campaignId)
    const riskContext = { campaignId: context.campaignId ?? undefined, phoneNumberId: context.sourceId,
      templateName: context.templateName }
    return await withGlobalSendGuard(phone, async db => {
      const {rows} = await db.query<{status:string;wamid:string|null}>(
        'SELECT status,wamid FROM cloud_messages WHERE id=$1', [messageId])
      if (rows[0]?.status !== 'queued' || rows[0]?.wamid) return null
      if (riskContext.campaignId) {
        const campaign = await db.query(`SELECT c.id FROM campaigns c WHERE c.id=$1
          AND c.status='running' AND ${CAMPAIGN_RISK_CLEAR_SQL} FOR SHARE OF c`, [riskContext.campaignId])
        if (!campaign.rows.length) throw new CampaignRiskError('La campaña está detenida o tiene una alerta de riesgo pendiente.')
      }
      await assertCloudSendRiskClear(riskContext, db)
      providerStarted = true
      return send()
    },context)
  } catch (error) {
    if (error instanceof OptOutError) {
      await markOptOutCancelled(messageId)
      return null
    }
    if (!providerStarted) {
      // A guard/database failure before the callback is a definite no-send.
      // Complete this queue item locally so restarts cannot replay it later.
      await markRiskCancelled(messageId)
      return null
    }
    if (error instanceof CloudApiError && error.code && context?.sourceId) {
      try {
        await recordCampaignProviderRisk({ campaignId: context.campaignId ?? undefined,
          phoneNumberId: context.sourceId, templateName: context.templateName,
          errorCode: error.code, errorMessage: error.message })
      } catch {
        console.error('[campaign-risk] No se pudo persistir la señal del proveedor de la cola')
        if (context.campaignId) await query(`UPDATE campaigns SET status='paused',pause_reason='risk_detected',updated_at=NOW()
          WHERE id=$1 AND status='running'`, [context.campaignId]).catch(() => {})
      }
    }
    throw error
  }
}
