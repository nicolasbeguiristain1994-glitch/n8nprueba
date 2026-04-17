import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const rows = await query<{
      phone_number: string; instance_name: string; notes: string | null
    }>(`SELECT phone_number, instance_name, notes FROM warmup_numbers WHERE id = $1`, [id])

    if (!rows.length) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    const { phone_number, instance_name, notes } = rows[0]

    // Check if already in whatsapp_lines
    const existing = await query(
      `SELECT id FROM whatsapp_lines WHERE evolution_instance = $1`, [instance_name]
    )
    if (existing.length) {
      return NextResponse.json({ error: 'Esta instancia ya existe en Difusión' }, { status: 409 })
    }

    // Generate line_key from instance_name
    const line_key = instance_name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

    await query(`
      INSERT INTO whatsapp_lines
        (line_key, display_name, phone_number, evolution_instance, status, notes)
      VALUES ($1, $2, $3, $4, 'active', $5)
    `, [line_key, notes || instance_name, phone_number, instance_name, notes])

    // Mark warmup as completed
    await query(
      `UPDATE warmup_numbers SET warmup_status = 'completed', updated_at = NOW() WHERE id = $1`, [id]
    )

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup/migrate POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
