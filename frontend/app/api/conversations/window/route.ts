import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { contactPhoneScope } from '@/lib/contact-visibility'
import { findConversationReplyOrigin } from '@/lib/conversation-reply-line'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth=await checkPermissionWithUser(req,'conversations','read')
  if (!auth.ok) return auth.response
  const phone=(req.nextUrl.searchParams.get('phone') || '').replace(/^\+/,'')
  if (!/^\d{7,15}$/.test(phone)) return NextResponse.json({error:'Teléfono inválido'},{status:400})
  try {
    const scope=contactPhoneScope(auth.user,'destination.phone',1,true)
    const [allowed]=await query(`SELECT 1 FROM (SELECT $1::text AS phone) destination WHERE ${scope.sql}`,[phone,...scope.params])
    if (!allowed) return NextResponse.json({error:'Fuera de tu alcance'},{status:403})
    const lineIds=await getAccessibleLineIds(auth.user)
    let origin=await findConversationReplyOrigin(phone,lineIds)
    if (!origin) {
      // Outbound-only Cloud threads have no customer window yet.
      const [outbound]=await query<NonNullable<Awaited<ReturnType<typeof findConversationReplyOrigin>>>>(`SELECT cn.whatsapp_line_id AS line_id, cc.phone_number_id, COALESCE(wl.display_name,wl.line_key) AS display_name, cc.window_expires_at
        FROM cloud_conversations cc JOIN cloud_numbers cn ON cn.phone_number_id=cc.phone_number_id JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
        WHERE regexp_replace(cc.contact_phone,'[^0-9]','','g')=$1 AND ($2::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($2::uuid[]))
        ORDER BY cc.last_message_at DESC NULLS LAST,cc.id DESC LIMIT 1`,[phone,lineIds])
      origin=outbound ?? null
    }
    return NextResponse.json({window:origin ? {lineName:origin.display_name,expiresAt:origin.window_expires_at} : null,serverNow:new Date().toISOString()},{headers:{'Cache-Control':'private, no-store'}})
  } catch { return NextResponse.json({error:'No se pudo consultar la ventana Cloud.'},{status:500}) }
}
