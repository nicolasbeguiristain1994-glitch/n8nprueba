import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { cloudNumberAccess } from '@/lib/cloud-api/access'
import { query } from '@/lib/db'
import { cloudMessageTextSql } from '@/lib/cloud-api/message-content'
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response
  const phoneNumberId = req.nextUrl.searchParams.get('phoneNumberId') || ''
  if (!/^\d{5,30}$/.test(phoneNumberId)) return NextResponse.json({ error: 'Seleccioná un número válido' }, { status: 400 })
  const denied = await cloudNumberAccess(auth.user, phoneNumberId)
  if (denied) return denied
  const contact = req.nextUrl.searchParams.get('contact')
  if (contact) {
    if (!/^\+[1-9]\d{6,14}$/.test(contact)) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })
    const messages = await query(`SELECT m.id,m.direction,m.message_type,m.content,m.status,m.sent_at,m.error_title,m.error_details
      FROM cloud_messages m JOIN cloud_conversations c ON c.id=m.conversation_id
      WHERE c.phone_number_id=$1 AND c.contact_phone=$2 ORDER BY m.created_at DESC LIMIT 100`, [phoneNumberId,contact])
    return NextResponse.json({ messages }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const conversations = await query(`SELECT c.id,c.contact_phone,c.window_expires_at,c.last_message_at,
    COALESCE(LEFT(latest.preview,100),c.last_message_preview) AS last_message_preview,c.unread_count
    FROM cloud_conversations c LEFT JOIN LATERAL (
      SELECT ${cloudMessageTextSql('m.content','m.message_type')} AS preview FROM cloud_messages m
      WHERE m.conversation_id=c.id ORDER BY COALESCE(m.sent_at,m.created_at) DESC,m.created_at DESC LIMIT 1
    ) latest ON true
    WHERE c.phone_number_id=$1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 100`,[phoneNumberId])
  return NextResponse.json({ conversations }, { headers: { 'Cache-Control': 'no-store' } })
}
