import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const err = await checkPermission(req, 'warmup', 'update')
  if (err) return err

  const { id } = await params
  let body: { is_active?: boolean }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    await query(
      `UPDATE warmup_contacts SET is_active = $2 WHERE id = $1`,
      [id, body.is_active ?? true],
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup/contacts PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const err = await checkPermission(req, 'warmup', 'delete')
  if (err) return err

  const { id } = await params
  try {
    await query(`DELETE FROM warmup_contacts WHERE id = $1`, [id])
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup/contacts DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
