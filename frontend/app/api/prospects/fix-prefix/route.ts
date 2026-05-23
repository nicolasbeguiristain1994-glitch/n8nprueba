import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'

// POST /api/prospects/fix-prefix
// Body: { batch_id?: string, list_id?: string, prefix: string }
// Agrega el prefijo (ej. '+549') a todos los números que NO empiecen con él,
// reemplazando el '+' inicial con el prefijo completo.
// Solo afecta prospectos con status != 'converted'.
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  let body: { batch_id?: string; list_id?: string; prefix?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const prefix = (body.prefix ?? '+549').trim()
  if (!prefix.startsWith('+') || prefix.length < 2) {
    return NextResponse.json({ error: 'prefix must start with + and have at least 2 chars' }, { status: 400 })
  }

  const { batch_id, list_id } = body
  if (!batch_id && !list_id) {
    return NextResponse.json({ error: 'Must provide batch_id or list_id' }, { status: 400 })
  }
  if (batch_id && !isUUID(batch_id)) return NextResponse.json({ error: 'Invalid batch_id' }, { status: 400 })
  if (list_id  && !isUUID(list_id))  return NextResponse.json({ error: 'Invalid list_id' }, { status: 400 })

  try {
    // Construimos el nuevo número: reemplazamos el '+' inicial por el prefijo completo.
    // Ej: '+1139063949' → '+549' + '1139063949' = '+5491139063949'
    // La condición NOT LIKE evita tocar números que ya tienen el prefijo correcto.
    const [{ count }] = await query<{ count: string }>(`
      WITH updated AS (
        UPDATE prospects
        SET phone_number = $1 || substring(phone_number FROM 2)
        WHERE status != 'converted'
          AND phone_number NOT LIKE $2
          AND ($3::uuid IS NULL OR import_batch_id = $3::uuid)
          AND ($4::uuid IS NULL OR EXISTS (
            SELECT 1 FROM prospect_list_members plm
            WHERE plm.prospect_id = id AND plm.prospect_list_id = $4::uuid
          ))
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM updated
    `, [prefix, `${prefix}%`, batch_id ?? null, list_id ?? null])

    return NextResponse.json({ fixed: Number(count) })
  } catch (e) {
    console.error('[POST /api/prospects/fix-prefix]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
