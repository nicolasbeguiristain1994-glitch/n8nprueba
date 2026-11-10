import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { requireConversation } from '@/lib/conversation-access'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { audit } from '@/lib/audit'
import { contactAccountKey } from '@/lib/contact-account-identity'

// Operators can save a sender from an authorized conversation without access
// to the full Contacts module. The phone and agent come from that thread.
export async function POST(req: NextRequest, { params }: { params: Promise<{ phone: string }> }) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'update')
  if (!auth.ok) return auth.response
  const { phone } = await params
  const digits = phone.replace(/\D/g, '')
  if (!isE164('+' + digits)) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 })
  }
  const name = body && typeof body === 'object' && 'name' in body && typeof body.name === 'string'
    ? body.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 100) {
    return NextResponse.json({ error: 'Ingresá un nombre de hasta 100 caracteres' }, { status: 400 })
  }

  try {
    const scope = await requireConversation(auth.user, digits, req.nextUrl.searchParams.get('agent'))
    const [firstName, ...rest] = name.split(' ')
    const [contact] = await query(`
      WITH saved AS (
        INSERT INTO contacts (external_id, phone_number, first_name, last_name, panel,
          status, opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at, identity_key, panels_assigned)
        SELECT gen_random_uuid()::text, $1, $3, $4, NULLIF($5, 'none'),
          'active', false, false, 'manual', NOW(), NOW(), $8,
          CASE WHEN $5='none' THEN '{}'::text[] ELSE ARRAY[$5]::text[] END
        WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE phone_number IN ($1, $2)
          AND panel IS NOT DISTINCT FROM NULLIF($5, 'none'))
        ON CONFLICT (identity_key) DO NOTHING
        RETURNING id AS contact_id, phone_number, first_name, last_name, segment
      ), visibility AS (
        INSERT INTO operator_contact_visibility (operator_id, contact_id, assigned_by)
        SELECT $6::uuid, saved.contact_id, $6::uuid FROM saved
        WHERE $7::text <> 'admin' AND EXISTS (
          SELECT 1 FROM operator_contact_visibility WHERE operator_id=$6::uuid
        )
        ON CONFLICT (operator_id, contact_id) DO NOTHING
      )
      SELECT * FROM saved`,
    ['+' + digits, digits, firstName, rest.join(' ') || null, scope.agent, auth.user.user_id, auth.user.role,
      contactAccountKey(scope.agent === 'none' ? null : scope.agent, null, '+' + digits)])
    if (!contact) return NextResponse.json({ error: 'Ya existe un contacto con ese teléfono. Actualizá la conversación.' }, { status: 409 })
    void audit({ req, action: 'create', resource: 'contacts', resource_id: String(contact.contact_id),
      metadata: { phone: '+' + digits, source: 'conversation', agent: scope.agent } })
    return NextResponse.json({ contact }, { status: 201 })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[POST /api/conversations/[phone]/contact]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo guardar el contacto. Intentá nuevamente.' }, { status: 500 })
  }
}
