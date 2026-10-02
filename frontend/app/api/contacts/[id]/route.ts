import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { contactScope, canAssignPanels } from '@/lib/contact-visibility'
import { parseBody, handleValidationError, UpdateContactSchema } from '@/lib/schema'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'update')
  if (!auth.ok) return auth.response
  const { user } = auth

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateContactSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'contacts')

  const { segment, gaming, panel, linea, linea_sub, first_name, last_name } = parsed.data

  if (panel !== undefined && !canAssignPanels(user, [panel])) {
    return NextResponse.json({error: 'Agente fuera de tu alcance'}, {status: 403})
  }
  try {
    const values: unknown[] = [id]
    const sets: string[] = []
    const changedFields: string[] = []
    const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
    for (const [field, value, cast] of [
      ['segment', segment, '::contact_segment'], ['gaming', gaming, '::gaming_type'],
      ['first_name', first_name, ''], ['last_name', last_name, ''],
    ] as const) {
      if (value !== undefined) { sets.push(`${field}=${bind(value || null)}${cast}`); changedFields.push(field) }
    }
    if (panel !== undefined) {
      const p = bind(panel)
      sets.push(`panel=${p}`, `panels_assigned=CASE WHEN ${p}::text IS NULL THEN panels_assigned
        ELSE ARRAY(SELECT DISTINCT unnest(panels_assigned || ARRAY[${p}]::text[])) END`)
      changedFields.push('panel')
    }
    const nextLine = linea !== undefined ? bind(linea) + '::smallint' : 'linea'
    if (linea !== undefined) { sets.push(`linea=${nextLine}`); changedFields.push('linea') }
    if (linea !== undefined || linea_sub !== undefined) {
      sets.push(`linea_sub=CASE WHEN ${nextLine} IS NULL THEN NULL ELSE ${linea_sub !== undefined ? bind(linea_sub) : 'linea_sub'} END`)
      if (linea_sub !== undefined) changedFields.push('linea_sub')
    }
    const scope = contactScope(user, values.length)
    const updated = await query<{id: string}>(`UPDATE contacts SET ${[...sets, 'updated_at=NOW()'].join(', ')}
      WHERE id=$1 AND ${scope.sql} RETURNING id`, [...values, ...scope.params])
    if (!updated[0]) return NextResponse.json({error: 'Contacto no disponible'}, {status: 403})

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
