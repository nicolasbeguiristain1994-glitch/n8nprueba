import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164, isUUID, clampStr } from '@/lib/validate'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { getEligibleLines, selectLine, sendViaEvolution } from '@/lib/campaign-distributor'

type LogEntry = {
  phone_number:         string
  message_body:         string
  status:               'sent' | 'failed'
  evolution_message_id: string
  campaign_id:          string
  error_detail:         string
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response
  const session = auth.user

  let body: { phones?: string[]; message?: string; campaign_id?: string; media_url?: string; media_type?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phones, message, campaign_id, media_url } = body

  if (!Array.isArray(phones) || phones.length === 0 || phones.length > 100) {
    return NextResponse.json({ error: 'phones debe ser un array de 1 a 100 números' }, { status: 400 })
  }

  // Normalize: strip spaces, dashes, parentheses then ensure + prefix for E.164.
  // Conversations stores phone from WhatsApp JID (no + prefix) — add it automatically.
  const normalizedPhones = phones.map((p: unknown) => {
    if (typeof p !== 'string') return p
    const stripped = p.replace(/[\s\-().]/g, '')
    return stripped.startsWith('+') ? stripped : '+' + stripped
  })
  const invalidPhone = normalizedPhones.find((p: unknown) => typeof p !== 'string' || !isE164(p))
  if (invalidPhone !== undefined) {
    return NextResponse.json({ error: `Teléfono inválido (debe ser E.164): ${invalidPhone}` }, { status: 400 })
  }
  const uniquePhones = [...new Set(normalizedPhones as string[])]
  const messageStr = clampStr(message, 4096)
  if (!messageStr) {
    return NextResponse.json({ error: 'message es requerido y no puede estar vacío' }, { status: 400 })
  }
  if (campaign_id !== undefined && campaign_id !== null && !isUUID(campaign_id)) {
    return NextResponse.json({ error: 'campaign_id debe ser un UUID válido' }, { status: 400 })
  }

  // Ownership check — prevent attaching sends to another user's campaign
  if (campaign_id) {
    const [camp] = await query<{ owned_by: string | null }>(
      'SELECT owned_by FROM campaigns WHERE id = $1', [campaign_id]
    )
    if (!camp) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    if (!isOwnerOrAdmin(session, camp.owned_by))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch eligible lines once — reuse across all phones in this request
  const eligibleLines = await getEligibleLines()
  if (eligibleLines.length === 0) {
    return NextResponse.json({ error: 'No hay líneas de WhatsApp disponibles' }, { status: 503 })
  }

  const results = []
  const logs: LogEntry[] = []

  // Send sequentially (antiblock) — collect results in memory
  for (const phone of uniquePhones) {
    // Pick a line using weighted selection (spreads load across available lines)
    const line = selectLine(eligibleLines) ?? eligibleLines[0]
    try {
      const { messageId } = await sendViaEvolution(line, phone, messageStr, media_url || null)

      logs.push({
        phone_number:         phone,
        message_body:         messageStr,
        status:               'sent',
        evolution_message_id: messageId ?? '',
        campaign_id:          campaign_id ?? '',
        error_detail:         '',
      })
      results.push({ phone, status: 'sent', id: messageId })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logs.push({
        phone_number:         phone,
        message_body:         messageStr,
        status:               'failed',
        evolution_message_id: '',
        campaign_id:          campaign_id ?? '',
        error_detail:         errMsg,
      })
      results.push({ phone, status: 'error', error: errMsg })
    }
    await new Promise(r => setTimeout(r, 200))
  }

  // Batch-insert all log rows — one query instead of N individual inserts
  if (logs.length > 0) {
    try {
      await query(
        `INSERT INTO whatsapp_messages
           (phone_number, message_body, direction, status, evolution_message_id,
            campaign_id, sent_at, failed_at, error_detail, created_at, updated_at)
         SELECT
           x.phone_number,
           x.message_body,
           'outbound',
           x.status::message_status,
           NULLIF(x.evolution_message_id, ''),
           NULLIF(x.campaign_id, '')::uuid,
           CASE WHEN x.status = 'sent'   THEN NOW() ELSE NULL END,
           CASE WHEN x.status = 'failed' THEN NOW() ELSE NULL END,
           NULLIF(x.error_detail, ''),
           NOW(), NOW()
         FROM jsonb_to_recordset($1::jsonb)
              AS x(phone_number text, message_body text, status text,
                   evolution_message_id text, campaign_id text, error_detail text)`,
        [JSON.stringify(logs)]
      )
    } catch (e) {
      console.error('[/api/send] batch log insert error:', e instanceof Error ? e.message : e)
    }
  }

  void audit({ req, action: 'send', resource: 'send',
    metadata: { count: uniquePhones.length, campaign_id: campaign_id ?? null } })
  return NextResponse.json({ results, total: uniquePhones.length })
}
