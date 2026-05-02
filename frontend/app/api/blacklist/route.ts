import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone, isUUID, clampStr } from '@/lib/validate'
import { audit } from '@/lib/audit'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type BlacklistRow = {
  id: string
  phone_number_raw: string
  phone_number_normalized: string
  reason: string | null
  source: 'manual' | 'automatic' | 'import'
  added_by: string | null
  added_by_name: string | null
  added_at: string
  removed_at: string | null
  removed_by: string | null
  removed_by_name: string | null
  campaign_id: string | null
  original_message: string | null
}

// ── GET /api/blacklist ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)
  const q       = searchParams.get('q')?.trim() ?? ''
  const source  = searchParams.get('source') ?? ''        // manual | automatic | import
  const status  = searchParams.get('status') ?? 'active'  // active | removed | all
  const from    = searchParams.get('from') ?? ''
  const to      = searchParams.get('to') ?? ''
  const page    = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const limit   = 50

  const conditions: string[] = []
  const params: unknown[]    = []
  let p = 0

  if (status === 'active') {
    conditions.push('b.removed_at IS NULL')
  } else if (status === 'removed') {
    conditions.push('b.removed_at IS NOT NULL')
  }

  if (q) {
    conditions.push(`b.phone_number_normalized ILIKE $${++p}`)
    params.push(`%${q.replace(/[^\d]/g, '')}%`)
  }

  if (source && ['manual', 'automatic', 'import'].includes(source)) {
    conditions.push(`b.source = $${++p}`)
    params.push(source)
  }

  if (from) {
    conditions.push(`b.added_at >= $${++p}`)
    params.push(from)
  }

  if (to) {
    conditions.push(`b.added_at <= $${++p}::date + interval '1 day'`)
    params.push(to)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const [rows, countRows] = await Promise.all([
      query<BlacklistRow>(
        `SELECT
           b.id, b.phone_number_raw, b.phone_number_normalized,
           b.reason, b.source, b.added_at, b.removed_at,
           b.campaign_id, b.original_message,
           ua.name AS added_by_name,
           ur.name AS removed_by_name,
           b.added_by, b.removed_by
         FROM blacklist b
         LEFT JOIN users ua ON ua.id = b.added_by
         LEFT JOIN users ur ON ur.id = b.removed_by
         ${where}
         ORDER BY b.added_at DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params,
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM blacklist b ${where}`,
        params,
      ),
    ])

    return NextResponse.json({
      items: rows,
      total: countRows[0]?.count ?? 0,
      page,
      limit,
    })
  } catch (e) {
    console.error('[/api/blacklist GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

// ── POST /api/blacklist ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response
  const session = auth.user

  let body: { phones?: string | string[]; reason?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  // Aceptar un string con varios números separados por salto de línea o un array
  const rawInput = body.phones
  let rawPhones: string[]

  if (typeof rawInput === 'string') {
    rawPhones = rawInput.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
  } else if (Array.isArray(rawInput)) {
    rawPhones = rawInput.map(s => String(s).trim()).filter(Boolean)
  } else {
    return NextResponse.json({ error: 'El campo phones es requerido' }, { status: 400 })
  }

  if (rawPhones.length === 0) {
    return NextResponse.json({ error: 'Debe ingresar al menos un número' }, { status: 400 })
  }

  const reason = clampStr(body.reason, 500) ?? 'Sin motivo especificado'

  // Normalizar y validar
  const toInsert: Array<{ raw: string; normalized: string }> = []
  const invalid: string[] = []

  for (const raw of rawPhones) {
    const normalized = normalizePhone(raw)
    if (!normalized) {
      invalid.push(raw)
    } else {
      toInsert.push({ raw, normalized })
    }
  }

  if (toInsert.length === 0) {
    return NextResponse.json({
      error: 'Ningún número válido encontrado',
      invalid,
    }, { status: 400 })
  }

  try {
    // Upsert: si existe un registro activo para ese número, lo ignora.
    // Si existe uno removido (soft-deleted), lo reactiva.
    const inserted: string[] = []
    const skipped: string[] = []

    for (const { raw, normalized } of toInsert) {
      // Comprobar si ya existe un registro activo
      const existing = await query<{ id: string }>(
        `SELECT id FROM blacklist WHERE phone_number_normalized = $1 AND removed_at IS NULL`,
        [normalized],
      )

      if (existing.length > 0) {
        skipped.push(raw)
        continue
      }

      // Si hay uno removido, reactivarlo
      const reactivated = await query<{ id: string }>(
        `UPDATE blacklist
         SET removed_at = NULL, removed_by = NULL,
             reason = $2, added_by = $3, added_at = NOW(), source = 'manual'
         WHERE phone_number_normalized = $1
           AND removed_at IS NOT NULL
         RETURNING id`,
        [normalized, reason, session.user_id],
      )

      if (reactivated.length > 0) {
        inserted.push(raw)
        continue
      }

      // Insertar nuevo
      await query(
        `INSERT INTO blacklist
           (phone_number_raw, phone_number_normalized, reason, source, added_by)
         VALUES ($1, $2, $3, 'manual', $4)`,
        [raw, normalized, reason, session.user_id],
      )
      inserted.push(raw)
    }

    void audit({
      req,
      action: 'create',
      resource: 'blacklist',
      metadata: { inserted: inserted.length, skipped: skipped.length, invalid: invalid.length },
    })

    return NextResponse.json({
      inserted: inserted.length,
      skipped: skipped.length,
      invalid,
      invalid_count: invalid.length,
    })
  } catch (e) {
    console.error('[/api/blacklist POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
