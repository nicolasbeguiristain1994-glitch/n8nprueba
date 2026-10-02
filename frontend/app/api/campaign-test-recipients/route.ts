import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID } from '@/lib/validate'
import { RegisterTestRecipientSchema } from '@/lib/campaign-test-sends'

export async function POST(req: Request) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin') return NextResponse.json({ error: 'Solo administradores pueden registrar números de prueba.' }, { status: 403 })
  const parsed = RegisterTestRecipientSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Completá el nombre y el teléfono internacional, por ejemplo +5491112345678.' }, { status: 400 })
  try {
    const [recipient] = await query(
      `INSERT INTO campaign_test_recipients (first_name, phone_number, created_by) VALUES ($1,$2,$3)
       ON CONFLICT (phone_number) DO UPDATE SET first_name=EXCLUDED.first_name, active=true, updated_at=now()
       RETURNING id, first_name, phone_number`,
      [parsed.data.first_name, parsed.data.phone_number, auth.user.user_id === 'bootstrap' ? null : auth.user.user_id])
    void audit({ req, action: 'create', resource: 'campaigns', metadata: { action: 'register_test_recipient', recipient_id: recipient.id } })
    return NextResponse.json({ recipient }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'No se pudo registrar el número de prueba.' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin') return NextResponse.json({ error: 'Solo administradores pueden quitar números de prueba.' }, { status: 403 })
  const body = await req.json().catch(() => null)
  if (typeof body?.id !== 'string' || !isUUID(body.id)) return NextResponse.json({ error: 'Número de prueba inválido.' }, { status: 400 })
  try {
    await query('UPDATE campaign_test_recipients SET active=false, updated_at=now() WHERE id=$1', [body.id])
    void audit({ req, action: 'update', resource: 'campaigns', metadata: { action: 'remove_test_recipient', recipient_id: body.id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'No se pudo quitar el número de prueba.' }, { status: 500 })
  }
}
