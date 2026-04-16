import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { segment, gaming, panel, linea } = await req.json()

  const allowedSegments = ['casual', 'regular', 'vip', 'premium']
  const allowedGaming   = ['slots', 'deportivas', 'ambas']
  const allowedPanels   = ['Betcoin', 'Zeus', 'Bigwin', 'Farabet', 'Las Vegas']

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
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await query(`DELETE FROM contacts WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
