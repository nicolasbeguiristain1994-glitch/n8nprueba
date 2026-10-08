import { z } from 'zod'
import { query, withTransaction } from '@/lib/db'
import { cloudEligibleExpr } from '@/lib/line-eligibility'
import { CampaignTemplateParamsSchema, validateCampaignTemplate } from '@/lib/campaign-template'
import { buildTemplatePayload, sendViaCloud, CloudSendOutcomeUnknownError } from '@/lib/campaign-distributor'
import { CloudApiError } from '@/lib/cloud-api/errors'
import type { CampaignForDispatch } from '@/lib/campaign-distributor'
import type { CampaignTestAttempt, CampaignTestLine, CampaignTestRecipient, CampaignTestSnapshot } from '@/lib/campaign-test-types'
import { CAMPAIGN_TEST_ATTEMPT_COLUMNS as ATTEMPT_COLUMNS, completeCampaignTestAttempt } from '@/lib/campaign-test-delivery'

export const RegisterTestRecipientSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  phone_number: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
}).strict()
export const SendCampaignTestSchema = z.object({
  request_id: z.string().uuid(), recipient_id: z.string().uuid(), line_id: z.string().uuid(),
}).strict()
export class CampaignTestError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

type Reader = typeof query
type TestCampaign = CampaignForDispatch & { template_components: unknown }

async function loadCampaign(id: string, read: Reader = query): Promise<TestCampaign> {
  const [campaign] = await read<TestCampaign>(
    `SELECT c.*, t.name AS template_name, t.language AS template_language,
       t.waba_id AS template_waba_id, t.status AS template_status, t.components AS template_components
     FROM campaigns c LEFT JOIN whatsapp_templates t ON t.id=c.template_id WHERE c.id=$1`, [id])
  if (!campaign) throw new CampaignTestError(404, 'Campaña no encontrada')
  if (campaign.message_type !== 'template') throw new CampaignTestError(400, 'Las pruebas se envían desde campañas con plantilla de Meta.')
  if (!campaign.template_id || !campaign.template_waba_id || campaign.template_status !== 'APROBADA')
    throw new CampaignTestError(409, 'La plantilla debe estar aprobada y asociada a una cuenta de WhatsApp.')
  const params = CampaignTemplateParamsSchema.safeParse(campaign.template_params ?? {})
  if (!params.success) throw new CampaignTestError(400, 'Los parámetros guardados de la plantilla son inválidos.')
  const error = validateCampaignTemplate(campaign.template_components, params.data)
  if (error) throw new CampaignTestError(400, error)
  campaign.template_params = params.data
  return campaign
}

async function loadLines(wabaId: string, read: Reader = query): Promise<CampaignTestLine[]> {
  return read<CampaignTestLine>(
    `SELECT wl.id, COALESCE(wl.display_name, wl.line_key) AS display_name, cn.phone_number_id
     FROM whatsapp_lines wl JOIN cloud_numbers cn ON cn.whatsapp_line_id=wl.id AND cn.status='active'
     WHERE cn.waba_id=$1 AND ${cloudEligibleExpr('wl')} ORDER BY wl.priority, wl.line_key`, [wabaId])
}

export async function getCampaignTestSnapshot(campaignId: string): Promise<CampaignTestSnapshot> {
  const campaign = await loadCampaign(campaignId)
  const [recipients, lines, attempts] = await Promise.all([
    query<CampaignTestRecipient>('SELECT id, first_name, phone_number FROM campaign_test_recipients WHERE active=true ORDER BY first_name'),
    loadLines(campaign.template_waba_id!),
    query<CampaignTestAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM campaign_test_sends WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 20`, [campaignId]),
  ])
  return { recipients, lines, attempts }
}

// This is a separate, explicitly requested send. The campaign's recipient queue,
// counters and contact_send_history are never reset or bypassed for normal sends.
export async function sendCampaignTest(
  campaignId: string, input: z.infer<typeof SendCampaignTestSchema>, userId: string,
): Promise<CampaignTestAttempt> {
  const claim = await withTransaction(async client => {
    const read: Reader = async <T>(sql: string, values?: unknown[]) => (await client.query(sql, values)).rows as T[]
    // A global request lock prevents the same UUID being used concurrently with different inputs.
    await read('SELECT pg_advisory_xact_lock(136, hashtext($1))', [input.request_id])
    const [existing] = await read<CampaignTestAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM campaign_test_sends WHERE id=$1`, [input.request_id])
    if (existing) {
      if (existing.campaign_id !== campaignId || existing.recipient_id !== input.recipient_id || existing.line_id !== input.line_id)
        throw new CampaignTestError(409, 'Esta solicitud ya pertenece a otra prueba.')
      return { attempt: existing }
    }
    // Serializes different requests to the same registered number, across campaigns and lines.
    const [recipient] = await read<CampaignTestRecipient>(
      'SELECT id, first_name, phone_number FROM campaign_test_recipients WHERE id=$1 AND active=true FOR UPDATE', [input.recipient_id])
    if (!recipient) throw new CampaignTestError(403, 'Seleccioná un número de prueba registrado y activo.')
    const [pending] = await read<{ id: string }>(
      `SELECT id FROM campaign_test_sends WHERE recipient_id=$1
       AND ((status='sending' AND created_at > now()-interval '2 minutes')
         OR created_at > now()-interval '10 seconds') LIMIT 1`, [recipient.id])
    if (pending) throw new CampaignTestError(409, 'Hay una prueba reciente o en procesamiento para este número. Esperá unos segundos y actualizá el historial.')
    const [blocked] = await read<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM blacklist WHERE removed_at IS NULL AND phone_number_normalized=regexp_replace($1,'[^0-9]','','g'))
       OR EXISTS (SELECT 1 FROM contacts WHERE do_not_contact=true AND regexp_replace(phone_number,'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g')) AS blocked`, [recipient.phone_number])
    if (blocked?.blocked) throw new CampaignTestError(422, 'Este número pidió no recibir mensajes o está en la lista de bloqueo.')
    const campaign = await loadCampaign(campaignId, read)
    const line = (await loadLines(campaign.template_waba_id!, read)).find(item => item.id === input.line_id)
    if (!line) throw new CampaignTestError(409, 'La línea no está disponible o no pertenece a la cuenta de la plantilla.')
    const content = buildTemplatePayload(campaign, recipient)
    const [attempt] = await read<CampaignTestAttempt>(
      `INSERT INTO campaign_test_sends
       (id, campaign_id, recipient_id, line_id, sent_by, first_name, phone_number, line_name, template_payload, phone_number_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING ${ATTEMPT_COLUMNS}`,
      [input.request_id, campaignId, recipient.id, line.id, userId === 'bootstrap' ? null : userId,
        recipient.first_name, recipient.phone_number, line.display_name, JSON.stringify(content), line.phone_number_id])
    return { attempt, line, content, campaign }
  })
  if (!claim.line || !claim.content || !claim.campaign) return claim.attempt

  let status: CampaignTestAttempt['status'] = 'sent'
  let providerId: string | null = null
  let error: string | null = null
  try {
    const result = await sendViaCloud(claim.line, claim.attempt.phone_number, {
      kind: 'template', content: claim.content,
      templateId: claim.campaign.template_id!, wabaId: claim.campaign.template_waba_id!,
    }, undefined, { reserveCapacity: true })
    providerId = result.messageId
    if (!providerId) throw new CloudSendOutcomeUnknownError()
  } catch (err) {
    const uncertain = err instanceof CloudSendOutcomeUnknownError || !(err instanceof CloudApiError)
    status = uncertain ? 'uncertain' : 'failed'
    error = uncertain ? 'No se pudo confirmar el resultado. Revisá el WhatsApp destinatario; esta prueba no se reenviará automáticamente.'
      : err.message.slice(0, 500)
  }
  try {
    return await completeCampaignTestAttempt(input.request_id, claim.line.phone_number_id, status, providerId, error)
  } catch {
    // The durable 'sending' record remains a fence even if Meta accepted the send.
    return { ...claim.attempt, status: 'uncertain', provider_message_id: providerId,
      error: 'El intento quedó registrado, pero su estado final no pudo guardarse. Revisá el WhatsApp destinatario antes de hacer otra prueba.' }
  }
}
