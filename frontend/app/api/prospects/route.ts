import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isE164, isUUID } from '@/lib/validate'

// GET /api/prospects
// Params: q, page, limit, status, stage, batch_id
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  const sp       = req.nextUrl.searchParams
  const search   = sp.get('q')        || ''
  const status   = sp.get('status')   || ''
  const stage    = sp.get('stage')    || ''
  const batchId  = sp.get('batch_id') || ''
  const listId   = sp.get('list_id')  || ''
  const filterTag = (sp.get('tag') || '').trim().slice(0, 100)
  const download = sp.get('download') === 'true'
  const page     = download ? 1 : Math.max(1, Number(sp.get('page') || 1))
  const limit    = download ? 100_000 : Math.min(200, Math.max(1, Number(sp.get('limit') || 50)))
  const offset   = download ? 0 : (page - 1) * limit

  if (status && !['active', 'unsubscribed', 'converted'].includes(status)) {
    return NextResponse.json({ error: `Invalid status "${status}"` }, { status: 400 })
  }
  if (stage && !['nuevo', 'contactado', 'interesado', 'descartado'].includes(stage)) {
    return NextResponse.json({ error: `Invalid stage "${stage}"` }, { status: 400 })
  }

  try {
    let rows: unknown[]
    // usedFallback indica que las columnas stage/converted_to_contact_id no existen en la DB
    // todavía (migración 098/099 pendiente). El count debe omitir p.stage en ese caso.
    let usedFallback = false
    try {
      rows = await query(`
        SELECT
          p.id, p.phone_number, p.first_name, p.last_name, p.email,
          p.tags, p.source, p.import_batch_id, p.status, p.stage, p.opt_in,
          p.consent_source, p.notes, p.converted_to_contact_id, p.created_at, p.updated_at,
          pib.filename AS batch_filename
        FROM prospects p
        LEFT JOIN prospect_import_batches pib ON pib.id = p.import_batch_id
        WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
          AND ($2 = '' OR p.status = $2)
          AND ($3 = '' OR p.stage  = $3)
          AND ($4 = '' OR p.import_batch_id::text = $4)
          AND ($5 = '' OR EXISTS (
            SELECT 1 FROM prospect_list_members plm
            WHERE plm.prospect_id = p.id AND plm.prospect_list_id::text = $5
          ))
          AND ($9 = '' OR p.tags @> ARRAY[$9]::text[])
        ORDER BY
          CASE
            WHEN $8 = '' THEN NULL::int
            WHEN LOWER(COALESCE(p.first_name,'')) = LOWER($8) THEN 0
            WHEN LOWER(COALESCE(p.last_name,''))  = LOWER($8) THEN 0
            ELSE 1
          END NULLS LAST,
          CASE WHEN $8 = '' THEN NULL::int
               ELSE LENGTH(COALESCE(p.first_name,'') || COALESCE(p.last_name,'')) END NULLS LAST,
          p.created_at DESC
        LIMIT $6 OFFSET $7
      `, [`%${search}%`, status, stage, batchId, listId, limit, offset, search, filterTag])
    } catch (e) {
      // Fallback: migración 098/099 no aplicadas aún en este entorno
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('converted_to_contact_id') || msg.includes('stage')) {
        usedFallback = true
        rows = await query(`
          SELECT
            p.id, p.phone_number, p.first_name, p.last_name, p.email,
            p.tags, p.source, p.import_batch_id, p.status,
            'nuevo'::text AS stage, p.opt_in,
            p.consent_source, p.notes, NULL::uuid AS converted_to_contact_id, p.created_at, p.updated_at,
            pib.filename AS batch_filename
          FROM prospects p
          LEFT JOIN prospect_import_batches pib ON pib.id = p.import_batch_id
          WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
            AND ($2 = '' OR p.status = $2)
            AND ($3 = '' OR p.import_batch_id::text = $3)
            AND ($7 = '' OR p.tags @> ARRAY[$7]::text[])
          ORDER BY
            CASE
              WHEN $6 = '' THEN NULL::int
              WHEN LOWER(COALESCE(p.first_name,'')) = LOWER($6) THEN 0
              WHEN LOWER(COALESCE(p.last_name,''))  = LOWER($6) THEN 0
              ELSE 1
            END NULLS LAST,
            CASE WHEN $6 = '' THEN NULL::int
                 ELSE LENGTH(COALESCE(p.first_name,'') || COALESCE(p.last_name,'')) END NULLS LAST,
            p.created_at DESC
          LIMIT $4 OFFSET $5
        `, [`%${search}%`, status, batchId, limit, offset, search, filterTag])
      } else {
        throw e
      }
    }

    const [{ count }] = usedFallback
      ? await query<{ count: string }>(
          `SELECT COUNT(*) FROM prospects p
           WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
             AND ($2 = '' OR p.status = $2)
             AND ($3 = '' OR p.import_batch_id::text = $3)
             AND ($4 = '' OR EXISTS (
               SELECT 1 FROM prospect_list_members plm
               WHERE plm.prospect_id = p.id AND plm.prospect_list_id::text = $4
             ))
             AND ($5 = '' OR p.tags @> ARRAY[$5]::text[])`,
          [`%${search}%`, status, batchId, listId, filterTag]
        )
      : await query<{ count: string }>(
          `SELECT COUNT(*) FROM prospects p
           WHERE ($1 = '' OR p.phone_number ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1)
             AND ($2 = '' OR p.status = $2)
             AND ($3 = '' OR p.stage  = $3)
             AND ($4 = '' OR p.import_batch_id::text = $4)
             AND ($5 = '' OR EXISTS (
               SELECT 1 FROM prospect_list_members plm
               WHERE plm.prospect_id = p.id AND plm.prospect_list_id::text = $5
             ))
             AND ($6 = '' OR p.tags @> ARRAY[$6]::text[])`,
          [`%${search}%`, status, stage, batchId, listId, filterTag]
        )

    if (download) return NextResponse.json({ contacts: rows })
    return NextResponse.json({ prospects: rows, total: Number(count), page, limit })
  } catch (e) {
    console.error('[GET /api/prospects]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/prospects — bulk delete: { ids: string[] } | { filters: { q, status, stage, batch_id, list_id } }
export async function DELETE(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  let body: { ids?: string[]; filters?: { q?: string; status?: string; stage?: string; batch_id?: string; list_id?: string } }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    if (Array.isArray(body.ids)) {
      const ids = body.ids.filter(isUUID)
      if (!ids.length) return NextResponse.json({ deleted: 0 })
      const [{ count }] = await query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM prospects WHERE id = ANY($1) AND status != 'converted' RETURNING 1
         )
         SELECT COUNT(*)::text AS count FROM deleted`,
        [ids]
      )
      return NextResponse.json({ deleted: Number(count) })
    }

    if (body.filters) {
      const { q = '', status = '', stage = '', batch_id = '', list_id = '' } = body.filters
      if (status && !['active', 'unsubscribed', 'converted'].includes(status)) {
        return NextResponse.json({ error: `Invalid status "${status}"` }, { status: 400 })
      }
      if (stage && !['nuevo', 'contactado', 'interesado', 'descartado'].includes(stage)) {
        return NextResponse.json({ error: `Invalid stage "${stage}"` }, { status: 400 })
      }
      const [{ count }] = await query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM prospects
           WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
             AND ($2 = '' OR status = $2)
             AND ($3 = '' OR stage  = $3)
             AND ($4 = '' OR import_batch_id::text = $4)
             AND ($5 = '' OR EXISTS (
               SELECT 1 FROM prospect_list_members plm
               WHERE plm.prospect_id = id AND plm.prospect_list_id::text = $5
             ))
             AND status != 'converted'
           RETURNING 1
         )
         SELECT COUNT(*)::text AS count FROM deleted`,
        [`%${q}%`, status, stage, batch_id, list_id]
      )
      return NextResponse.json({ deleted: Number(count) })
    }

    return NextResponse.json({ error: 'Must provide ids or filters' }, { status: 400 })
  } catch (e) {
    console.error('[DELETE /api/prospects]', e instanceof Error ? e.message : e)
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
