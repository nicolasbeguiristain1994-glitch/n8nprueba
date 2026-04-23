import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Promotes warmup number to production line — admin only
  const err = await checkPermission(req, 'warmup', 'manage')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const rows = await query<{
      phone_number: string; instance_name: string; notes: string | null
    }>(`SELECT phone_number, instance_name, notes FROM warmup_numbers WHERE id = $1`, [id])

    if (!rows.length) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    const { phone_number, instance_name, notes } = rows[0]

    // Generate line_key from instance_name
    const line_key = instance_name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

    // ON CONFLICT DO NOTHING makes concurrent calls idempotent; RETURNING id
    // distinguishes "inserted now" (row returned) from "already existed" (no row).
    const inserted = await query<{ id: string }>(
      `INSERT INTO whatsapp_lines
         (line_key, display_name, phone_number, evolution_instance, status, notes)
       VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (evolution_instance) DO NOTHING
       RETURNING id`,
      [line_key, notes || instance_name, phone_number, instance_name, notes]
    )

    if (!inserted.length) {
      return NextResponse.json({ error: 'Esta instancia ya existe en Difusión' }, { status: 409 })
    }

    // Mark warmup as completed only when the line was actually inserted
    await query(
      `UPDATE warmup_numbers SET warmup_status = 'completed', updated_at = NOW() WHERE id = $1`, [id]
    )

    void audit({ req, action: 'migrate', resource: 'warmup', resource_id: id,
      metadata: { instance_name } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup/migrate POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
