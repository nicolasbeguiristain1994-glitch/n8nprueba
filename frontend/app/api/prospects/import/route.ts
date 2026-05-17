import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

// POST /api/prospects/import
//
// Body: {
//   rows:     Array<{ phone: string; first_name?: string; last_name?: string; email?: string }>
//   filename: string   (nombre del archivo original)
//   notes?:   string
// }
//
// Flujo:
//   1. Normaliza y valida teléfonos E.164 en JS
//   2. Dedup intra-archivo
//   3. Bulk INSERT ON CONFLICT DO NOTHING contra prospects
//   4. Cross-check advertencia contra contacts (no bloquea importación)
//   5. Crea prospect_import_batches con métricas
//   6. Retorna métricas + lista de warnings (teléfonos ya en contacts)

interface ImportRow {
  phone:       string
  first_name?: string | null
  last_name?:  string | null
  email?:      string | null
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!auth.ok) return auth.response

  let body: { rows?: ImportRow[]; filename?: string; notes?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { rows = [], filename = 'importación', notes } = body

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No se enviaron filas para importar' }, { status: 400 })
  }
  if (rows.length > 50_000) {
    return NextResponse.json({ error: 'Máximo 50.000 filas por importación' }, { status: 400 })
  }

  // ── 1. Normalización y validación en JS ──────────────────────────────────────
  let skippedInvalid = 0
  const seen = new Set<string>()
  const normalized: Array<{ phone: string; first_name: string | null; last_name: string | null; email: string | null }> = []

  for (const r of rows) {
    const phone = (r.phone || '').toString().trim().replace(/\s/g, '')
    if (!phone) { skippedInvalid++; continue }
    if (!isE164(phone)) { skippedInvalid++; continue }
    if (seen.has(phone)) continue   // dedup intra-archivo (silencioso, no cuenta como "inválido")
    seen.add(phone)
    normalized.push({
      phone,
      first_name: r.first_name?.trim() || null,
      last_name:  r.last_name?.trim()  || null,
      email:      r.email?.trim()      || null,
    })
  }

  const totalRows = rows.length

  if (normalized.length === 0) {
    return NextResponse.json({
      batch_id: null,
      imported: 0, skipped_duplicates: 0,
      skipped_invalid: skippedInvalid,
      warned_existing_contacts: 0,
      total_rows: totalRows,
      warnings: [],
    })
  }

  // ── 2. Bulk INSERT + conteo de duplicados ─────────────────────────────────────
  // Usamos jsonb_to_recordset para inserción masiva en una sola query.
  // ON CONFLICT DO NOTHING retorna solo las filas insertadas —
  // la diferencia entre normalized.length y count(inserted) = duplicados.
  let importedCount    = 0
  let skippedDuplicates = 0

  try {
    const [result] = await query<{ inserted: string }>(
      `WITH input AS (
         SELECT phone, first_name, last_name, email
         FROM   jsonb_to_recordset($1::jsonb)
                AS x(phone text, first_name text, last_name text, email text)
       ), ins AS (
         INSERT INTO prospects (phone_number, first_name, last_name, email, source, consent_source)
         SELECT phone, NULLIF(first_name,''), NULLIF(last_name,''), NULLIF(email,''),
                'csv_import', 'csv_import'
         FROM   input
         ON CONFLICT (phone_number) DO NOTHING
         RETURNING id
       )
       SELECT COUNT(*)::text AS inserted FROM ins`,
      [JSON.stringify(normalized.map(r => ({
        phone:      r.phone,
        first_name: r.first_name,
        last_name:  r.last_name,
        email:      r.email,
      })))]
    )
    importedCount     = Number(result?.inserted ?? 0)
    skippedDuplicates = normalized.length - importedCount
  } catch (e) {
    console.error('[prospects/import] bulk insert error', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al insertar prospectos' }, { status: 500 })
  }

  // ── 3. Cross-check advertencia contra contacts ────────────────────────────────
  // Identifica teléfonos que ya existen en contacts para mostrar advertencia.
  // No bloquea ni revierte la importación.
  let warnedCount = 0
  const warnings: string[] = []

  try {
    const phones = normalized.map(r => r.phone)
    const existingInContacts = await query<{ phone_number: string }>(
      `SELECT phone_number FROM contacts WHERE phone_number = ANY($1::text[])`,
      [phones]
    )
    existingInContacts.forEach(r => warnings.push(r.phone_number))
    warnedCount = warnings.length
  } catch {
    // Non-critical — just skip warnings if query fails
  }

  // ── 4. Crear registro de batch ────────────────────────────────────────────────
  let batchId: string | null = null
  try {
    const [batchRow] = await query<{ id: string }>(
      `INSERT INTO prospect_import_batches
         (filename, total_rows, imported, skipped_duplicates, skipped_invalid,
          warned_existing_contacts, created_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        filename, totalRows, importedCount, skippedDuplicates,
        skippedInvalid, warnedCount,
        auth.user.user_id, notes || null,
      ]
    )
    batchId = batchRow?.id ?? null

    // Vincular el batch a los prospectos recién insertados (los que no tenían batch_id)
    if (batchId && importedCount > 0) {
      await query(
        `UPDATE prospects
         SET import_batch_id = $1
         WHERE phone_number = ANY($2::text[])
           AND import_batch_id IS NULL`,
        [batchId, normalized.map(r => r.phone)]
      )
    }
  } catch (e) {
    console.error('[prospects/import] batch record error', e instanceof Error ? e.message : e)
    // No es crítico — devolvemos el resultado igual
  }

  return NextResponse.json({
    batch_id:                 batchId,
    imported:                 importedCount,
    skipped_duplicates:       skippedDuplicates,
    skipped_invalid:          skippedInvalid,
    warned_existing_contacts: warnedCount,
    total_rows:               totalRows,
    warnings:                 warnings.slice(0, 50),  // máximo 50 en respuesta
  })
}
