import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone, clampStr } from '@/lib/validate'
import { audit } from '@/lib/audit'

/**
 * POST /api/blacklist/import
 *
 * Body JSON:
 *   {
 *     phones:  string[]     // números raw ya parseados del CSV/Excel en el frontend
 *     reason?: string       // motivo aplicado a todos
 *     preview?: boolean     // si true, solo devuelve conteos sin insertar
 *   }
 *
 * Response:
 *   {
 *     inserted:  number
 *     skipped:   number   // ya existían en blacklist activa
 *     invalid:   number   // no pasaron normalización
 *     previewed: boolean
 *   }
 */
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response
  const session = auth.user

  let body: { phones?: unknown; reason?: unknown; preview?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if (!Array.isArray(body.phones)) {
    return NextResponse.json({ error: 'phones debe ser un array' }, { status: 400 })
  }

  const rawPhones = (body.phones as unknown[])
    .map(p => String(p).trim())
    .filter(Boolean)

  if (rawPhones.length === 0) {
    return NextResponse.json({ error: 'La lista está vacía' }, { status: 400 })
  }

  const reason  = clampStr(body.reason, 500) ?? 'Importación masiva'
  const preview = body.preview === true

  // Normalizar
  const valid: Array<{ raw: string; normalized: string }> = []
  let invalidCount = 0

  for (const raw of rawPhones) {
    const normalized = normalizePhone(raw)
    if (!normalized) {
      invalidCount++
    } else {
      valid.push({ raw, normalized })
    }
  }

  if (valid.length === 0) {
    return NextResponse.json({
      inserted: 0,
      skipped: 0,
      invalid: invalidCount,
      previewed: preview,
    })
  }

  // Obtener los que ya existen en blacklist activa
  const normalizedList = valid.map(v => v.normalized)
  const existingRows = await query<{ phone_number_normalized: string }>(
    `SELECT phone_number_normalized
     FROM blacklist
     WHERE phone_number_normalized = ANY($1::text[])
       AND removed_at IS NULL`,
    [normalizedList],
  )
  const existingSet = new Set(existingRows.map(r => r.phone_number_normalized))

  const toInsert = valid.filter(v => !existingSet.has(v.normalized))
  const skippedCount = valid.length - toInsert.length

  if (preview) {
    return NextResponse.json({
      inserted: toInsert.length,
      skipped: skippedCount,
      invalid: invalidCount,
      previewed: true,
    })
  }

  // Insertar en lote
  if (toInsert.length > 0) {
    // Insertar de a bloques de 500 para no generar queries gigantes
    const chunkSize = 500
    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize)

      const valuePlaceholders = chunk
        .map((_, idx) => {
          const base = idx * 4
          return `($${base + 1}, $${base + 2}, $${base + 3}, 'import', $${base + 4})`
        })
        .join(', ')

      const params: unknown[] = []
      for (const { raw, normalized } of chunk) {
        params.push(raw, normalized, reason, session.user_id)
      }

      await query(
        `INSERT INTO blacklist (phone_number_raw, phone_number_normalized, reason, source, added_by)
         VALUES ${valuePlaceholders}
         ON CONFLICT (phone_number_normalized) WHERE removed_at IS NULL DO NOTHING`,
        params,
      )
    }
  }

  void audit({
    req,
    action: 'import',
    resource: 'blacklist',
    metadata: { inserted: toInsert.length, skipped: skippedCount, invalid: invalidCount },
  })

  return NextResponse.json({
    inserted: toInsert.length,
    skipped: skippedCount,
    invalid: invalidCount,
    previewed: false,
  })
}
