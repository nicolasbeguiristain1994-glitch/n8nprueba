import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { emitWarmupChange } from '@/lib/warmup-sse'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'warmup', 'update')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const updated = await query<{ id: string }>(
      `UPDATE warmup_numbers
       SET current_day = 1, messages_sent_today = 0,
           warmup_status = 'active', start_date = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [id]
    )
    if (!updated.length) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    void audit({ req, action: 'reset', resource: 'warmup', resource_id: id })
    emitWarmupChange()
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup/[id]/reset POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
