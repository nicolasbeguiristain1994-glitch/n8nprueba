import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { status } = await req.json()

  const allowed = ['paused', 'cancelled', 'draft']
  if (!allowed.includes(status)) {
    return NextResponse.json({ error: 'Status inválido' }, { status: 400 })
  }

  await query(
    `UPDATE campaigns SET status = $1::campaign_status, updated_at = NOW() WHERE id = $2`,
    [status, id]
  )

  return NextResponse.json({ ok: true })
}
