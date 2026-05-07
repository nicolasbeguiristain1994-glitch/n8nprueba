import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

// Normaliza teléfono: quita + y espacios para comparar consistentemente
const normalize = (p: string) => p.replace(/^\+/, '').replace(/\s/g, '')

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'conversations', 'read')
  if (err) return err

  const phoneRaw = req.nextUrl.searchParams.get('phone')

  try {
    if (phoneRaw) {
      const phone = normalize(phoneRaw)
      const messages = await query(`
        SELECT id, phone_number, message_body, direction, status, created_at, evolution_message_id
        FROM whatsapp_messages
        WHERE REPLACE(phone_number, '+', '') = $1
        ORDER BY created_at ASC
        LIMIT 200
      `, [phone])
      return NextResponse.json({ messages })
    }

    // Lista de conversaciones — enriquecida con datos del contacto si existe
    const conversations = await query(`
      SELECT DISTINCT ON (REPLACE(wm.phone_number, '+', ''))
        REPLACE(wm.phone_number, '+', '')        AS phone_number,
        wm.message_body                          AS last_message,
        wm.direction                             AS last_direction,
        wm.status                                AS last_status,
        wm.created_at                            AS last_at,
        COALESCE(cs.is_escalated, false)         AS is_escalated,
        cs.escalation_reason,
        cs.current_flow                          AS conv_flow,
        EXISTS (
          SELECT 1 FROM blacklist bl
          WHERE bl.phone_number_normalized = REPLACE(wm.phone_number, '+', '')
          AND   bl.removed_at IS NULL
        )                                        AS is_blacklisted,
        EXISTS (
          SELECT 1 FROM conversation_notes cn
          WHERE cn.phone = REPLACE(wm.phone_number, '+', '')
          AND   cn.content LIKE '%Seguimiento programado%'
        )                                        AS has_follow_up,
        c.id                                     AS contact_id,
        c.first_name,
        c.last_name,
        c.segment::text                          AS segment,
        (SELECT REPLACE(tag, 'casino:actividad:', '')
         FROM contact_tags
         WHERE contact_id = c.id AND tag LIKE 'casino:actividad:%'
         LIMIT 1)                                AS actividad,
        (SELECT REPLACE(tag, 'casino:valor_riesgo:', '')
         FROM contact_tags
         WHERE contact_id = c.id AND tag LIKE 'casino:valor_riesgo:%'
         LIMIT 1)                                AS valor_riesgo
      FROM whatsapp_messages wm
      LEFT JOIN conversation_state cs
        ON cs.phone_number = REPLACE(wm.phone_number, '+', '')
        AND cs.resolved_at IS NULL
      LEFT JOIN contacts c
        ON REPLACE(c.phone_number, '+', '') = REPLACE(wm.phone_number, '+', '')
      ORDER BY REPLACE(wm.phone_number, '+', ''), wm.created_at DESC
      LIMIT 200
    `)

    // Ordenar por último mensaje más reciente
    const sorted = (conversations as Array<{ last_at: string }>)
      .sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime())

    return NextResponse.json({ conversations: sorted })
  } catch (e) {
    console.error('[/api/conversations GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
