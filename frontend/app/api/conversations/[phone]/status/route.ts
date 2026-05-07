import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

type Params = { params: Promise<{ phone: string }> }

// PATCH /api/conversations/[phone]/status — actualiza current_flow de la conversación
export async function PATCH(req: NextRequest, { params }: Params) {
  const err = await checkPermission(req, 'conversations', 'read')
  if (err) return err

  const { phone } = await params
  let body: { flow?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const flow = body.flow?.trim() || null

  try {
    // UPSERT: si existe conversación activa la actualiza, sino la crea
    await query(
      `INSERT INTO conversation_state (phone_number, current_flow, last_activity_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (phone_number) WHERE resolved_at IS NULL
       DO UPDATE SET current_flow = $2, last_activity_at = NOW(), updated_at = NOW()`,
      [phone, flow]
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PATCH /api/conversations/[phone]/status]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
