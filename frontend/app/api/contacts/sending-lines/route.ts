import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { contactRead } from '@/lib/contact-read'

export async function GET(req: NextRequest) {
  const auth=await checkPermissionWithUser(req,'contacts','read')
  if(!auth.ok)return auth.response
  try {
    const lines=await contactRead(`SELECT id,COALESCE(NULLIF(display_name,''),line_key) AS name,phone_number AS phone
      FROM whatsapp_lines WHERE id IN (SELECT get_accessible_line_ids($1::uuid))
      ORDER BY COALESCE(NULLIF(display_name,''),line_key),phone_number,id`,[auth.user.user_id])
    return NextResponse.json({lines},{headers:{'Cache-Control':'private, no-store'}})
  } catch {
    return NextResponse.json({error:'No se pudieron consultar las líneas de envío. Volvé a intentar.'},{status:503})
  }
}
