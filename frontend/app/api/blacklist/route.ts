import { contactScope } from '@/lib/contact-visibility'
import { canonicalContactAgent } from '@/lib/contact-account-identity'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone } from '@/lib/validate'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, CreateBlacklistSchema } from '@/lib/schema'

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
           b.reason, b.source, b.added_at, b.removed_at,b.agent_code,b.scope_key,
           b.campaign_id, b.original_message,
           ua.name AS added_by_name,
           ur.name AS removed_by_name,
           b.added_by, b.removed_by,
           consent.metadata->>'input_type' AS input_type,
           COALESCE(wl.display_name,consent.phone_number_id) AS origin_line,
           cp.name AS campaign_name
         FROM blacklist b
         LEFT JOIN users ua ON ua.id = b.added_by
         LEFT JOIN users ur ON ur.id = b.removed_by
         LEFT JOIN LATERAL (SELECT cl.phone_number_id,cl.metadata FROM cloud_consent_log cl
           WHERE cl.contact_phone='+'||b.phone_number_normalized AND cl.event='opt_out'
             AND cl.metadata->>'blacklist_id'=b.id::text ORDER BY cl.created_at DESC LIMIT 1) consent ON true
         LEFT JOIN cloud_numbers cn ON cn.phone_number_id=consent.phone_number_id
         LEFT JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
         LEFT JOIN campaigns cp ON cp.id=b.campaign_id
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

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateBlacklistSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'blacklist')

  // Aceptar un string con varios números separados por salto de línea o un array
  let rawPhones: string[]
  if (typeof parsed.data.phones === 'string') {
    rawPhones = parsed.data.phones.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
  } else {
    rawPhones = parsed.data.phones.map(s => s.trim()).filter(Boolean)
  }

  // Un string de solo separadores puede quedar vacío tras el split
  if (rawPhones.length === 0) {
    return NextResponse.json({ error: 'Debe ingresar al menos un número' }, { status: 400 })
  }

  const reason = parsed.data.reason?.trim() ?? 'Sin motivo especificado'
  if(parsed.data.contact_ids?.length) {
    const scope=contactScope(session,1,'c')
    const rows=await query<{phone_number:string;panel:string|null}>(`SELECT phone_number,panel FROM contacts c
      WHERE c.id=ANY($1::uuid[]) AND ${scope.sql}`,[parsed.data.contact_ids,...scope.params])
    if(rows.length!==new Set(parsed.data.contact_ids).size || rows.some(r=>!r.panel)) return NextResponse.json({error:'Revisá el agente y acceso de las cuentas seleccionadas.'},{status:409})
    const entries=[...new Map(rows.map(r=>[`${r.phone_number}:${r.panel}`,r])).values()]
    let inserted=0
    for(const row of entries) {
      const agent=canonicalContactAgent(row.panel)!
      const created=await query(`INSERT INTO blacklist(phone_number_raw,phone_number_normalized,reason,source,added_by,agent_code,scope_key)
        VALUES($1,$2,$3,'manual',$4,$5,'agent:'||$5) ON CONFLICT(phone_number_normalized,scope_key) WHERE removed_at IS NULL DO NOTHING RETURNING id`,
        [row.phone_number,normalizePhone(row.phone_number),reason,session.user_id,agent])
      inserted+=created.length
    }
    void audit({req,action:'create',resource:'blacklist',metadata:{scope:'agent',inserted}})
    return NextResponse.json({inserted,skipped:entries.length-inserted,invalid:[],invalid_count:0})
  }

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
    // Las bajas históricas se conservan; cada bloqueo nuevo crea otro registro.
    const inserted: string[] = []
    const skipped: string[] = []

    for (const { raw, normalized } of toInsert) {
      // Comprobar si ya existe un registro activo
      const existing = await query<{ id: string }>(
        `SELECT id FROM blacklist WHERE phone_number_normalized = $1 AND removed_at IS NULL AND scope_key='global'`,
        [normalized],
      )

      if (existing.length > 0) {
        skipped.push(raw)
        continue
      }

      // Insertar nuevo
      await query(
        `INSERT INTO blacklist
           (phone_number_raw, phone_number_normalized, reason, source, added_by)
         VALUES ($1, $2, $3, 'manual', $4)
         ON CONFLICT(phone_number_normalized,scope_key) WHERE removed_at IS NULL DO NOTHING`,
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
