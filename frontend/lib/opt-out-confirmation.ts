import { query, withTransaction } from '@/lib/db'
import { normalizePhone } from '@/lib/validate'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { enforceRateLimit } from '@/lib/cloud-api/rate-limiter'
import { MetaHttpGateway } from '@/lib/cloud-api/infrastructure/meta-http.gateway'

export const OPT_OUT_CONFIRMATION = 'Disculpá las molestias. Ya registramos tu baja y no vas a recibir más mensajes promocionales de nuestra parte.'

type Request = { phone: string; sourceId: string; messageId: string; provider: 'cloud' | 'evolution' }
type Source = { conversation_id?: string; line_id: string; evolution_url?: string | null }

// This is the sole fixed-text exception to the global send prohibition. It is
// reachable only with a committed inbound BAJA receipt, never an arbitrary body.
// Reserve the attempt and history together before HTTP. An ambiguous send is
// not retried: provider timeouts and webhook redelivery must not duplicate it.
export async function sendOptOutConfirmation(request: Request): Promise<void> {
  const phone = normalizePhone(request.phone)
  if (!phone || !/^\d+$/.test(phone) || !request.messageId) return
  const sourceId = request.provider === 'cloud' ? request.sourceId : `evolution:${request.sourceId}`
  const receiptParams = ['+' + phone, sourceId, request.messageId]
  const pendingSql = `SELECT l.id FROM cloud_consent_log l JOIN blacklist b
    ON b.id::text=l.metadata->>'blacklist_id' AND b.phone_number_normalized=$4 AND b.removed_at IS NULL
    WHERE l.contact_phone=$1 AND l.phone_number_id=$2 AND l.message_wamid=$3
      AND l.event='opt_out' AND l.source='inbound_message'
      AND l.metadata->'confirmation'->>'status'='pending'`
  if (!(await query(pendingSql, [...receiptParams, phone])).length) return

  let send: () => Promise<string>
  // Resolve credentials before claiming: failures here can safely retry.
  if (request.provider === 'cloud') {
    const token = await getTokenForNumber(request.sourceId)
    await enforceRateLimit(request.sourceId)
    const gateway = new MetaHttpGateway(token, { timeoutMs: 12000, circuitBreakerKey: `meta:send:${request.sourceId}` })
    send = async () => {
      const result = await gateway.post<{ messages?: Array<{ id: string }> }>(`/${request.sourceId}/messages`, {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: phone,
        type: 'text', text: { body: OPT_OUT_CONFIRMATION, preview_url: false },
      })
      if (!result.messages?.[0]?.id) throw new Error('Missing provider message ID')
      return result.messages[0].id
    }
  } else {
    const apiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
    if (!apiKey) throw new Error('Evolution credentials unavailable for BAJA confirmation')
    send = async () => {
      const url = claimed!.source.evolution_url || process.env.EVOLUTION_URL
      if (!url) throw new Error('Evolution URL unavailable')
      const response = await fetch(`${url}/message/sendText/${encodeURIComponent(request.sourceId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body: JSON.stringify({ number: phone, text: OPT_OUT_CONFIRMATION }), signal: AbortSignal.timeout(12000),
      })
      if (!response.ok) throw new Error(`Evolution HTTP ${response.status}`)
      const result = await response.json()
      const id = result?.key?.id || result?.id
      if (typeof id !== 'string' || !id) throw new Error('Missing provider message ID')
      return id
    }
  }

  const claimed = await withTransaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`global-opt-out:${phone}`])
    const receipt = (await db.query<{id:string}>(pendingSql, [...receiptParams, phone])).rows[0]
    if (!receipt) return null
    let source: Source | undefined
    if (request.provider === 'cloud') {
      source = (await db.query<Source>(`SELECT c.id AS conversation_id, wl.id AS line_id
        FROM cloud_messages m JOIN cloud_conversations c ON c.id=m.conversation_id
        JOIN cloud_numbers cn ON cn.phone_number_id=c.phone_number_id
        JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
        WHERE m.wamid=$1 AND m.direction='inbound' AND c.contact_phone=$2 AND c.phone_number_id=$3
          AND m.sent_at>NOW()-interval '24 hours' AND c.window_expires_at>NOW()
          AND cn.status='active' AND wl.status='active' AND wl.is_connected=true AND wl.sending_enabled=true`,
      [request.messageId, '+'+phone, request.sourceId])).rows[0]
    } else {
      source = (await db.query<Source>(`SELECT wl.id AS line_id, wl.evolution_url FROM whatsapp_lines wl
        WHERE wl.evolution_instance=$1 AND wl.line_type='evolution' AND wl.status='active'
          AND wl.is_connected=true AND wl.sending_enabled=true
          AND EXISTS(SELECT 1 FROM whatsapp_messages m WHERE m.evolution_message_id=$2
            AND regexp_replace(m.phone_number,'[^0-9]','','g')=$3 AND m.direction='inbound'
            AND m.created_at>NOW()-interval '24 hours') LIMIT 1`,
      [request.sourceId, request.messageId, phone])).rows[0]
    }
    if (!source) {
      await db.query(`UPDATE cloud_consent_log SET metadata=jsonb_set(metadata,'{confirmation}',
        '{"status":"skipped","reason":"origin_unavailable_or_expired"}'::jsonb) WHERE id=$1`, [receipt.id])
      return null
    }
    if (request.provider === 'evolution' && !source.evolution_url && !process.env.EVOLUTION_URL) {
      throw new Error('Evolution URL unavailable for BAJA confirmation')
    }
    // Receipt UUID is also the history UUID, making reconciliation unambiguous.
    if (request.provider === 'cloud') {
      await db.query(`INSERT INTO cloud_messages
        (id,conversation_id,phone_number_id,direction,message_type,content,status,queued_at)
        VALUES($1,$2,$3,'outbound','text',$4::jsonb,'queued',NOW())`,
      [receipt.id, source.conversation_id, request.sourceId, JSON.stringify({text:{body:OPT_OUT_CONFIRMATION},source:'opt_out_confirmation'})])
    } else {
      await db.query(`INSERT INTO whatsapp_messages(id,phone_number,message_body,direction,status,metadata)
        VALUES($1,$2,$3,'outbound','queued',$4::jsonb)`,
      [receipt.id, '+'+phone, OPT_OUT_CONFIRMATION, JSON.stringify({line_id:source.line_id,source:'opt_out_confirmation',consent_id:receipt.id})])
    }
    await db.query(`UPDATE cloud_consent_log SET metadata=jsonb_set(metadata,'{confirmation}',
      jsonb_build_object('status','sending','message_id',$1::text,'started_at',NOW())) WHERE id=$1::uuid`, [receipt.id])
    return {id:receipt.id,source}
  })
  if (!claimed) return

  let wamid: string | null = null
  try { wamid = await send() }
  catch {
    // Do not roll back consent or retry a request that may have been accepted.
    console.warn(JSON.stringify({event:'opt_out.confirmation_uncertain',consentId:claimed.id,provider:request.provider}))
  }
  await withTransaction(async db => {
    if (request.provider === 'cloud') {
      await db.query(`UPDATE cloud_messages SET wamid=$2,status=$3,
        sent_at=CASE WHEN $2::text IS NOT NULL THEN NOW() ELSE sent_at END,
        failed_at=CASE WHEN $2::text IS NULL THEN NOW() ELSE NULL END,
        error_title=CASE WHEN $2::text IS NULL THEN 'confirmation_uncertain' ELSE NULL END,
        error_details=CASE WHEN $2::text IS NULL THEN 'Confirmación de baja sin respuesta del proveedor; no se reenvía automáticamente' ELSE NULL END
        WHERE id=$1`, [claimed.id, wamid, wamid ? 'sent' : 'failed'])
    } else {
      await db.query(`UPDATE whatsapp_messages SET evolution_message_id=$2,status=$3,updated_at=NOW() WHERE id=$1`,
        [claimed.id, wamid, wamid ? 'sent' : 'failed'])
    }
    await db.query(`UPDATE cloud_consent_log SET metadata=jsonb_set(metadata,'{confirmation}',
      metadata->'confirmation'||jsonb_build_object('status',$2::text,'wamid',$3::text,'finished_at',NOW())) WHERE id=$1`,
    [claimed.id, wamid ? 'sent' : 'uncertain', wamid])
  })
}
