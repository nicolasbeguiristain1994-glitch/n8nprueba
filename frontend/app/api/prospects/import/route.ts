import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164, isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

// POST /api/prospects/import
//
// Soporta importaciones grandes mediante chunking.
//
// Chunk 1 (sin batch_id):
//   Body: { rows, filename, total_rows, notes? }
//   Crea el registro de batch y retorna { batch_id, imported, skipped_duplicates, skipped_invalid, total_rows }
//
// Chunks 2+ (con batch_id):
//   Body: { rows, batch_id }
//   Inserta filas e incrementa contadores del batch existente.
//   Retorna { imported, skipped_duplicates, skipped_invalid }

export const maxDuration = 60  // Vercel: máximo 60s por chunk

interface ImportRow {
  phone:        string
  first_name?:  string | null
  last_name?:   string | null
  email?:       string | null
  part_number?: number | null
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!auth.ok) return auth.response

  let body: {
    rows?:       ImportRow[]
    filename?:   string
    notes?:      string
    batch_id?:   string
    total_rows?: number
    replace?:    boolean
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { rows = [], filename = 'importación', notes, batch_id, total_rows, replace = false } = body

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No se enviaron filas para importar' }, { status: 400 })
  }
  if (rows.length > 10_000) {
    return NextResponse.json({ error: 'Máximo 10.000 filas por chunk' }, { status: 400 })
  }
  if (batch_id && !isUUID(batch_id)) {
    return NextResponse.json({ error: 'batch_id inválido' }, { status: 400 })
  }

  // ── 1. Normalización y validación ────────────────────────────────────────────
  let skippedInvalid = 0
  const seen = new Set<string>()
  const normalized: Array<{ phone: string; first_name: string | null; last_name: string | null; email: string | null; part_number: number | null }> = []

  for (const r of rows) {
    const phone = (r.phone || '').toString().trim().replace(/\s/g, '')
    if (!phone) { skippedInvalid++; continue }
    if (!isE164(phone)) { skippedInvalid++; continue }
    if (seen.has(phone)) continue
    seen.add(phone)
    normalized.push({
      phone,
      first_name:  r.first_name?.trim()  || null,
      last_name:   r.last_name?.trim()   || null,
      email:       r.email?.trim()       || null,
      part_number: r.part_number ?? null,
    })
  }

  const chunkTotalRows = rows.length

  // ── 2. Bulk INSERT / UPSERT ──────────────────────────────────────────────────
  let importedCount     = 0
  let updatedCount      = 0
  let skippedDuplicates = 0

  if (normalized.length > 0) {
    try {
      const jsonInput = JSON.stringify(normalized.map(r => ({
        phone:      r.phone,
        first_name: r.first_name,
        last_name:  r.last_name,
        email:      r.email,
      })))

      if (replace) {
        const [result] = await query<{ inserted: string; updated: string }>(
          `WITH input AS (
             SELECT phone, first_name, last_name, email
             FROM   jsonb_to_recordset($1::jsonb)
                    AS x(phone text, first_name text, last_name text, email text)
           ), ins AS (
             INSERT INTO prospects (phone_number, first_name, last_name, email, source, consent_source)
             SELECT phone, NULLIF(first_name,''), NULLIF(last_name,''), NULLIF(email,''),
                    'csv_import', 'csv_import'
             FROM   input
             ON CONFLICT (phone_number) DO UPDATE SET
               first_name = EXCLUDED.first_name,
               last_name  = EXCLUDED.last_name,
               email      = EXCLUDED.email,
               updated_at = NOW()
             RETURNING id, (xmax = 0) AS is_new
           )
           SELECT
             COUNT(*) FILTER (WHERE is_new)::text  AS inserted,
             COUNT(*) FILTER (WHERE NOT is_new)::text AS updated
           FROM ins`,
          [jsonInput]
        )
        importedCount = Number(result?.inserted ?? 0)
        updatedCount  = Number(result?.updated  ?? 0)
      } else {
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
          [jsonInput]
        )
        importedCount     = Number(result?.inserted ?? 0)
        skippedDuplicates = normalized.length - importedCount
      }
    } catch (e) {
      console.error('[prospects/import] bulk insert error', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Error al insertar prospectos' }, { status: 500 })
    }
  }

  // ── 3. Batch record ───────────────────────────────────────────────────────────
  let resolvedBatchId = batch_id ?? null

  if (!batch_id) {
    // Primer chunk: crear registro de batch
    try {
      const [batchRow] = await query<{ id: string }>(
        `INSERT INTO prospect_import_batches
           (filename, total_rows, imported, skipped_duplicates, skipped_invalid,
            warned_existing_contacts, created_by, notes)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
         RETURNING id`,
        [
          filename,
          total_rows ?? chunkTotalRows,
          importedCount + updatedCount,
          skippedDuplicates,
          skippedInvalid,
          auth.user.user_id,
          notes || null,
        ]
      )
      resolvedBatchId = batchRow?.id ?? null
    } catch (e) {
      console.error('[prospects/import] batch create error', e instanceof Error ? e.message : e)
    }
  } else {
    // Chunks siguientes: incrementar contadores del batch existente
    try {
      await query(
        `UPDATE prospect_import_batches
         SET imported           = imported           + $2,
             skipped_duplicates = skipped_duplicates + $3,
             skipped_invalid    = skipped_invalid    + $4
         WHERE id = $1`,
        [batch_id, importedCount + updatedCount, skippedDuplicates, skippedInvalid]
      )
    } catch (e) {
      console.error('[prospects/import] batch update error', e instanceof Error ? e.message : e)
    }
  }

  // ── 4. Vincular prospectos al batch ───────────────────────────────────────────
  if (resolvedBatchId && (importedCount > 0 || updatedCount > 0)) {
    try {
      await query(
        `UPDATE prospects
         SET import_batch_id = $1
         WHERE phone_number = ANY($2::text[])
           AND import_batch_id IS NULL`,
        [resolvedBatchId, normalized.map(r => r.phone)]
      )
    } catch (e) {
      console.error('[prospects/import] batch link error', e instanceof Error ? e.message : e)
    }
  }

  // ── 5. Etiquetar partes ───────────────────────────────────────────────────────
  const partsMap = new Map<number, string[]>()
  for (const r of normalized) {
    if (r.part_number) {
      const phones = partsMap.get(r.part_number) ?? []
      phones.push(r.phone)
      partsMap.set(r.part_number, phones)
    }
  }
  for (const [part, phones] of partsMap) {
    const tag = `parte:${part}`
    try {
      await query(
        `UPDATE prospects
         SET tags = array_append(COALESCE(tags, '{}'), $1)
         WHERE phone_number = ANY($2::text[])
           AND NOT (COALESCE(tags, '{}') @> ARRAY[$1]::text[])`,
        [tag, phones]
      )
    } catch (e) {
      console.error('[prospects/import] parte tag error', e instanceof Error ? e.message : e)
    }
  }

  return NextResponse.json({
    batch_id:           resolvedBatchId,
    imported:           importedCount,
    updated:            updatedCount,
    skipped_duplicates: skippedDuplicates,
    skipped_invalid:    skippedInvalid,
    total_rows:         chunkTotalRows,
    warned_existing_contacts: 0,
    warnings:           [],
  })
}
