import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { canSeeContact } from '@/lib/contact-visibility'
import { parseBody, handleValidationError, UpdateContactSchema } from '@/lib/schema'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'update')
  if (!auth.ok) return auth.response
  const { user } = auth

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // Verificar visibilidad: operadores solo pueden editar contactos asignados
  if (!(await canSeeContact(user.role, user.user_id, id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateContactSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'contacts')

  const { segment, gaming, panel, linea, first_name, last_name } = parsed.data

  try {
    const existing = await query<{ id: string }>('SELECT id FROM contacts WHERE id = $1', [id])
    if (!existing[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const changedFields: string[] = []

    if (segment !== undefined) {
      await query(`UPDATE contacts SET segment = $1::contact_segment, updated_at = NOW() WHERE id = $2`, [segment, id])
      changedFields.push('segment')
    }

    if (gaming !== undefined) {
      await query(`UPDATE contacts SET gaming = $1::gaming_type, updated_at = NOW() WHERE id = $2`, [gaming, id])
      changedFields.push('gaming')
    }

    if (panel !== undefined) {
      await query(
        `UPDATE contacts
         SET panel           = $1,
             panels_assigned = CASE
               WHEN $1 IS NULL THEN panels_assigned
               WHEN $1 = ANY(panels_assigned) THEN panels_assigned
               ELSE (SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(panels_assigned || ARRAY[$1]) ORDER BY unnest))
             END,
             updated_at = NOW()
         WHERE id = $2`,
        [panel, id]
      )
      changedFields.push('panel')
    }

    if (linea !== undefined) {
      await query(`UPDATE contacts SET linea = $1, updated_at = NOW() WHERE id = $2`, [linea, id])
      changedFields.push('linea')
    }

    if (first_name !== undefined) {
      await query(`UPDATE contacts SET first_name = $1, updated_at = NOW() WHERE id = $2`, [first_name || null, id])
      changedFields.push('first_name')
    }

    if (last_name !== undefined) {
      await query(`UPDATE contacts SET last_name = $1, updated_at = NOW() WHERE id = $2`, [last_name || null, id])
      changedFields.push('last_name')
    }

    void audit({ req, action: 'update', resource: 'contacts', resource_id: id,
      metadata: { changedFields } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/contacts PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // delete = admin-only (operator canAccess blocks delete action)
  const auth = await checkPermissionWithUser(req, 'contacts', 'delete')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  try {
    const deleted = await query<{ id: string }>(`DELETE FROM contacts WHERE id = $1 RETURNING id`, [id])
    if (!deleted[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    void audit({ req, action: 'delete', resource: 'contacts', resource_id: id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/contacts DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
