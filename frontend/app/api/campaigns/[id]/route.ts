import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = checkPermission(req, 'campaigns', 'update')
  if (err) return err

  const { id } = await params

  let body: { status?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { status } = body

  const allowed = ['paused', 'cancelled', 'draft']
  if (!status || !allowed.includes(status)) {
    return NextResponse.json({ error: 'Status inválido' }, { status: 400 })
  }

  try {
    await query(
      `UPDATE campaigns SET status = $1::campaign_status, updated_at = NOW() WHERE id = $2`,
      [status, id]
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/campaigns PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
