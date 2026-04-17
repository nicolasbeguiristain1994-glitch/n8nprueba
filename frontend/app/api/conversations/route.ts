import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

// Normaliza teléfono: quita + y espacios para comparar consistentemente
const normalize = (p: string) => p.replace(/^\+/, '').replace(/\s/g, '')

export async function GET(req: NextRequest) {
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

    // Lista de conversaciones — agrupa outbound e inbound del mismo número
    const conversations = await query(`
      SELECT DISTINCT ON (REPLACE(phone_number, '+', ''))
        REPLACE(phone_number, '+', '') AS phone_number,
        message_body  AS last_message,
        direction     AS last_direction,
        status        AS last_status,
        created_at    AS last_at
      FROM whatsapp_messages
      ORDER BY REPLACE(phone_number, '+', ''), created_at DESC
      LIMIT 60
    `)

    // Ordenar por último mensaje más reciente
    const sorted = (conversations as Array<{last_at: string}>)
      .sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime())

    return NextResponse.json({ conversations: sorted })
  } catch (e) {
    console.error('[/api/conversations GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
