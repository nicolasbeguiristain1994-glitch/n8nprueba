/**
 * PATCH  /api/warmup/conversations/[id]  — pausa, reanuda o cancela
 * DELETE /api/warmup/conversations/[id]  — elimina conversación (solo si no está in_progress)
 */

import { NextRequest, NextResponse } from 'next/server'
import { query }                     from '@/lib/db'

// ── PATCH ─────────────────────────────────────────────────────────────────────

interface PatchBody {
  status: 'paused' | 'pending' | 'failed'
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body: PatchBody = await req.json()

    const allowed = ['paused', 'pending', 'failed'] as const
    if (!allowed.includes(body.status as typeof allowed[number])) {
      return NextResponse.json(
        { error: 'status debe ser paused, pending o failed' },
        { status: 400 },
      )
    }

    const [updated] = await query<{ id: string }>(`
      UPDATE warmup_conversations
      SET    status     = $2,
             updated_at = NOW()
      WHERE  id         = $1
        AND  status NOT IN ('completed')
      RETURNING id
    `, [params.id, body.status])

    if (!updated) {
      return NextResponse.json(
        { error: 'Conversación no encontrada o ya completada' },
        { status: 404 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[conversations/[id] PATCH]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await query(`
      DELETE FROM warmup_conversations
      WHERE id = $1
    `, [params.id])

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[conversations/[id] DELETE]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
