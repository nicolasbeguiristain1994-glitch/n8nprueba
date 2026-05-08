/**
 * POST /api/warmup/alerts/[id]/resolve
 *
 * Marca una alerta como resuelta.
 *
 * Response:
 *   { ok: true, resolvedAt: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const permErr = await checkPermission(req, 'warmup', 'update')
  if (permErr) return permErr

  const { id } = await context.params

  try {
    const rows = await query<{ resolved_at: string }>(`
      UPDATE warmup_alerts
      SET    resolved_at = NOW(),
             resolved_by = 'dashboard'
      WHERE  id = $1
        AND  resolved_at IS NULL
      RETURNING resolved_at
    `, [id])

    if (!rows.length) {
      return NextResponse.json(
        { error: 'Alerta no encontrada o ya resuelta' },
        { status: 404 },
      )
    }

    return NextResponse.json({ ok: true, resolvedAt: rows[0].resolved_at })

  } catch (e) {
    console.error('[POST /api/warmup/alerts/[id]/resolve]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
