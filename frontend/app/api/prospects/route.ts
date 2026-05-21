import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isE164 } from '@/lib/validate'

// GET /api/prospects
// Params: q, page, limit, status, batch_id
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  const sp       = req.nextUrl.searchParams
  const search   = sp.get('q')        || ''
  const status   = sp.get('status')   || ''
  const batchId  = sp.get('batch_id') || ''
  const page     = Math.max(1, Number(sp.get('page') || 1))
  const limit    = Math.min(200, Math.max(1, Number(sp.get('limit') || 50)))
  const offset   = (page - 1) * limit

  if (status && !['active', 'unsubscribed', 'converted'].includes(status)) {
    return NextResponse.json({ error: `Invalid status "${status}"` }, { status: 400 })
  }

  try {
    let rows: unknown[]
    try {
      rows = await query(`
        SELECT
          p.id, p.phone_number, p.first_name, p.last_name, p.email,
          p.tags, p.source, p.import_batch_id, p.status, p.opt_in,
          p.consent_source, p.notes, p.converted_to_contact_id, p.created_at, p.updated_at,
          pib.filename AS batch_filename
        FROM prospects p
        LEFT JOIN prospect_import_batches pib ON pib.id = p.import_batch_id
        WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
          AND ($2 = '' OR p.status = $2)
          AND ($3 = '' OR p.import_batch_id::text = $3)
        ORDER BY p.created_at DESC
        LIMIT $4 OFFSET $5
      `, [`%${search}%`, status, batchId, limit, offset])
    } catch (e) {
      // Fallback: migración 098 (converted_to_contact_id) no aplicada aún
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('converted_to_contact_id')) {
        rows = await query(`
          SELECT
            p.id, p.phone_number, p.first_name, p.last_name, p.email,
            p.tags, p.source, p.import_batch_id, p.status, p.opt_in,
            p.consent_source, p.notes, NULL::uuid AS converted_to_contact_id, p.created_at, p.updated_at,
            pib.filename AS batch_filename
          FROM prospects p
          LEFT JOIN prospect_import_batches pib ON pib.id = p.import_batch_id
          WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
            AND ($2 = '' OR p.status = $2)
            AND ($3 = '' OR p.import_batch_id::text = $3)
          ORDER BY p.created_at DESC
          LIMIT $4 OFFSET $5
        `, [`%${search}%`, status, batchId, limit, offset])
      } else {
        throw e
      }
    }

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM prospects p
       WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
         AND ($2 = '' OR p.status = $2)
         AND ($3 = '' OR p.import_batch_id::text = $3)`,
      [`%${search}%`, status, batchId]
    )

    return NextResponse.json({ prospects: rows, total: Number(count), page, limit })
  } catch (e) {
    console.error('[GET /api/prospects]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/prospects — crear un prospect manual
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!auth.ok) return auth.response

  let body: { phone?: string; first_name?: string; last_name?: string; email?: string; notes?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const phone = (body.phone || '').trim().replace(/\s/g, '')
  if (!phone) return NextResponse.json({ error: 'Teléfono requerido' }, { status: 400 })
  if (!isE164(phone)) return NextResponse.json({ error: 'Teléfono debe estar en formato E.164' }, { status: 400 })

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO prospects (phone_number, first_name, last_name, email, notes, source, consent_source)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'manual')
       ON CONFLICT (phone_number) DO NOTHING
       RETURNING id`,
      [phone, body.first_name || null, body.last_name || null, body.email || null, body.notes || null]
    )
    if (!row) return NextResponse.json({ error: 'Ya existe un prospecto con ese teléfono' }, { status: 409 })
    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (e) {
    console.error('[POST /api/prospects]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
