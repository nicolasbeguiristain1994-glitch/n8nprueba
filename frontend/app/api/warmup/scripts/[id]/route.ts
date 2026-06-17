/**
 * GET    /api/warmup/scripts/[id]  — detalle del script con todos sus pasos
 * DELETE /api/warmup/scripts/[id]  — elimina script y sus pasos (CASCADE)
 */

import { NextRequest, NextResponse } from 'next/server'
import { query }                     from '@/lib/db'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const [script] = await query<{
      id:          string
      name:        string
      description: string | null
      total_steps: number
      created_at:  string
    }>(`
      SELECT id, name, description, total_steps, created_at
      FROM   warmup_scripts
      WHERE  id = $1
    `, [id])

    if (!script) {
      return NextResponse.json({ error: 'Script no encontrado' }, { status: 404 })
    }

    const steps = await query<{
      id:            string
      step_order:    number
      speaker_alias: string
      content:       string
    }>(`
      SELECT id, step_order, speaker_alias, content
      FROM   warmup_script_steps
      WHERE  script_id = $1
      ORDER  BY step_order ASC
    `, [id])

    return NextResponse.json({ ...script, steps })
  } catch (err) {
    console.error('[warmup/scripts/[id] GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const [active] = await query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM   warmup_conversations
      WHERE  script_id = $1
        AND  status IN ('pending', 'in_progress')
    `, [id])

    if (parseInt(active?.count ?? '0') > 0) {
      return NextResponse.json(
        { error: 'No se puede eliminar: el script tiene conversaciones activas. Pausalas primero.' },
        { status: 409 },
      )
    }

    await query(`DELETE FROM warmup_scripts WHERE id = $1`, [id])

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[warmup/scripts/[id] DELETE]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
