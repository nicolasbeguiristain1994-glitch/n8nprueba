import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, SendSchema } from '@/lib/schema'
import { getEligibleLines, selectLine, sendViaEvolution, type EligibleLine } from '@/lib/campaign-distributor'
import { sseEmitter } from '@/lib/sse-events'

type LogEntry = {
  phone_number:         string
  message_body:         string
  status:               'sent' | 'failed'
  evolution_message_id: string
  campaign_id:          string
  error_detail:         string
}

// Devuelve la línea fija asignada al número si existe y sigue disponible.
// Si no, elige una nueva y la persiste en phone_line_assignments.
async function getOrAssignLine(
  phone: string,
  eligibleLines: EligibleLine[],
): Promise<EligibleLine> {
  const normalized = phone.replace(/^\+/, '')

  const [existing] = await query<{ line_id: string }>(
    `SELECT line_id FROM phone_line_assignments WHERE phone = $1`,
    [normalized],
  )

  if (existing?.line_id) {
    const fixed = eligibleLines.find(l => l.id === existing.line_id)
    if (fixed) return fixed
    // La línea asignada ya no está disponible — reasignar
  }

  const line = selectLine(eligibleLines) ?? eligibleLines[0]

  await query(
    `INSERT INTO phone_line_assignments (phone, line_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone) DO UPDATE SET line_id = EXCLUDED.line_id, updated_at = NOW()`,
    [normalized, line.id],
  )

  return line
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response
  const session = auth.user

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(SendSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'send')
  const { phones: rawPhones, message: messageStr, campaign_id, media_url } = parsed.data

  // Normalize: strip spaces, dashes, parentheses then ensure + prefix for E.164.
  const normalizedPhones = rawPhones.map(p => {
    const stripped = p.replace(/[\s\-().]/g, '')
    return stripped.startsWith('+') ? stripped : '+' + stripped
  })
  const invalidPhone = normalizedPhones.find(p => !isE164(p))
  if (invalidPhone !== undefined) {
    return NextResponse.json({ error: `Teléfono inválido (debe ser E.164): ${invalidPhone}` }, { status: 400 })
  }
  const uniquePhones = [...new Set(normalizedPhones)]

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
    // Línea fija por número: si el contacto tiene una línea asignada, usar esa siempre
    const line = await getOrAssignLine(phone, eligibleLines)
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

      // Notificar en tiempo real a todos los clientes SSE conectados
      sseEmitter.emit('update', { source: 'message' })
    } catch (e) {
      console.error('[/api/send] batch log insert error:', e instanceof Error ? e.message : e)
    }
  }

  void audit({ req, action: 'send', resource: 'send',
    metadata: { count: uniquePhones.length, campaign_id: campaign_id ?? null } })
  return NextResponse.json({ results, total: uniquePhones.length })
}
