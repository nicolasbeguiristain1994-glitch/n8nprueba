import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'contacts', 'update')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: { segment?: string | null; gaming?: string | null; panel?: string | null; linea?: number | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { segment, gaming, panel, linea } = body

  const allowedSegments = ['casual', 'regular', 'vip', 'premium']
  const allowedGaming   = ['slots', 'deportivas', 'ambas']
  const allowedPanels   = ['Betcoin', 'Zeus', 'Bigwin', 'Farabet', 'Las Vegas']

  try {
    const changedFields: string[] = []

    if (segment !== undefined) {
      if (segment !== null && !allowedSegments.includes(segment))
        return NextResponse.json({ error: 'Segmento inválido' }, { status: 400 })
      await query(`UPDATE contacts SET segment = $1::contact_segment, updated_at = NOW() WHERE id = $2`, [segment, id])
      changedFields.push('segment')
    }

    if (gaming !== undefined) {
      if (gaming !== null && !allowedGaming.includes(gaming))
        return NextResponse.json({ error: 'Gaming inválido' }, { status: 400 })
      await query(`UPDATE contacts SET gaming = $1::gaming_type, updated_at = NOW() WHERE id = $2`, [gaming, id])
      changedFields.push('gaming')
    }

    if (panel !== undefined) {
      if (panel !== null && !allowedPanels.includes(panel))
        return NextResponse.json({ error: 'Panel inválido' }, { status: 400 })
      await query(`UPDATE contacts SET panel = $1, updated_at = NOW() WHERE id = $2`, [panel, id])
      changedFields.push('panel')
    }

    if (linea !== undefined) {
      const lineaNum = linea === null ? null : Number(linea)
      if (lineaNum !== null && (lineaNum < 1 || lineaNum > 12))
        return NextResponse.json({ error: 'Línea inválida (1-12)' }, { status: 400 })
      await query(`UPDATE contacts SET linea = $1, updated_at = NOW() WHERE id = $2`, [lineaNum, id])
      changedFields.push('linea')
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
  const err = await checkPermission(req, 'contacts', 'delete')
  if (err) return err

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
