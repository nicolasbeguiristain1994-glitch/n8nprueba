import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

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
    if (segment !== undefined) {
      if (segment !== null && !allowedSegments.includes(segment))
        return NextResponse.json({ error: 'Segmento inválido' }, { status: 400 })
      await query(`UPDATE contacts SET segment = $1::contact_segment, updated_at = NOW() WHERE id = $2`, [segment, id])
    }

    if (gaming !== undefined) {
      if (gaming !== null && !allowedGaming.includes(gaming))
        return NextResponse.json({ error: 'Gaming inválido' }, { status: 400 })
      await query(`UPDATE contacts SET gaming = $1::gaming_type, updated_at = NOW() WHERE id = $2`, [gaming, id])
    }

    if (panel !== undefined) {
      if (panel !== null && !allowedPanels.includes(panel))
        return NextResponse.json({ error: 'Panel inválido' }, { status: 400 })
      await query(`UPDATE contacts SET panel = $1, updated_at = NOW() WHERE id = $2`, [panel, id])
    }

    if (linea !== undefined) {
      const lineaNum = linea === null ? null : Number(linea)
      if (lineaNum !== null && (lineaNum < 1 || lineaNum > 12))
        return NextResponse.json({ error: 'Línea inválida (1-12)' }, { status: 400 })
      await query(`UPDATE contacts SET linea = $1, updated_at = NOW() WHERE id = $2`, [lineaNum, id])
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/contacts PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await query(`DELETE FROM contacts WHERE id = $1`, [id])
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/contacts DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
