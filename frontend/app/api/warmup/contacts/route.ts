import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { isE164 } from '@/lib/validate'

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'warmup', 'read')
  if (err) return err

  try {
    const rows = await query(`
      SELECT id, phone_number, is_active, message_count, last_used_at, notes
      FROM   warmup_contacts
      ORDER  BY message_count ASC, phone_number ASC
    `)
    return NextResponse.json({ contacts: rows })
  } catch (e) {
    console.error('[/api/warmup/contacts GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'warmup', 'create')
  if (err) return err

  let body: { phone_numbers?: string[]; notes?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { phone_numbers = [], notes = '' } = body
  if (!Array.isArray(phone_numbers) || phone_numbers.length === 0) {
    return NextResponse.json({ error: 'phone_numbers requerido (array)' }, { status: 400 })
  }

  const invalid = phone_numbers.filter(p => !isE164(p.trim()))
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Números inválidos (deben estar en formato E.164): ${invalid.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    const result = await query<{ count: string }>(`
      WITH ins AS (
        INSERT INTO warmup_contacts (phone_number, notes)
        SELECT TRIM(v), $2
        FROM   unnest($1::text[]) AS v
        ON CONFLICT (phone_number) DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM ins
    `, [phone_numbers.map(p => p.trim()), notes])

    return NextResponse.json({ ok: true, added: Number(result[0]?.count ?? 0) })
  } catch (e) {
    console.error('[/api/warmup/contacts POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
