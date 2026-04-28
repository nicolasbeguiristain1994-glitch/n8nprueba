// PATCH /api/proxies/:id  — update proxy fields
// DELETE /api/proxies/:id — soft-delete (set is_active = false)
//
// Both require: lines:update

import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { isUUID, clampStr } from '@/lib/validate'

// ── PATCH ─────────────────────────────────────────────────────────────────────

const VALID_PROTOCOLS   = new Set(['http', 'https', 'socks5'])
const VALID_PROXY_TYPES = new Set(['datacenter', 'residential', 'mobile'])
const VALID_HEALTH      = new Set(['healthy', 'degraded', 'unhealthy', 'unknown'])

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) {
    return NextResponse.json({ error: 'id must be a valid UUID' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Build SET clause from allowed updatable fields
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  const addField = (col: string, val: unknown) => {
    sets.push(`${col} = $${idx++}`)
    values.push(val)
  }

  if ('label'              in body) addField('label',              clampStr(body.label, 100))
  if ('host'               in body) addField('host',               clampStr(body.host,  255))
  if ('port'               in body) {
    const p = typeof body.port === 'number' ? Math.round(body.port) : null
    if (!p || p < 1 || p > 65535)
      return NextResponse.json({ error: 'port must be between 1 and 65535' }, { status: 400 })
    addField('port', p)
  }
  if ('protocol'           in body) {
    const v = String(body.protocol)
    if (!VALID_PROTOCOLS.has(v))
      return NextResponse.json({ error: `protocol must be one of: ${[...VALID_PROTOCOLS].join(', ')}` }, { status: 400 })
    addField('protocol', v)
  }
  if ('username'           in body) addField('username',           clampStr(body.username, 100))
  if ('password_ref'       in body) addField('password_ref',       clampStr(body.password_ref, 500))
  if ('country'            in body) addField('country',            clampStr(body.country, 2)?.toUpperCase() ?? null)
  if ('region'             in body) addField('region',             clampStr(body.region, 50))
  if ('city'               in body) addField('city',               clampStr(body.city, 50))
  if ('provider'           in body) addField('provider',           clampStr(body.provider, 100))
  if ('proxy_type'         in body) {
    const v = String(body.proxy_type)
    if (!VALID_PROXY_TYPES.has(v))
      return NextResponse.json({ error: `proxy_type must be one of: ${[...VALID_PROXY_TYPES].join(', ')}` }, { status: 400 })
    addField('proxy_type', v)
  }
  if ('rotating_endpoint'  in body) addField('rotating_endpoint',  body.rotating_endpoint === true)
  if ('is_active'          in body) addField('is_active',          body.is_active === true)
  if ('health_status'      in body) {
    const v = String(body.health_status)
    if (!VALID_HEALTH.has(v))
      return NextResponse.json({ error: `health_status must be one of: ${[...VALID_HEALTH].join(', ')}` }, { status: 400 })
    addField('health_status', v)
  }
  if ('latency_ms'         in body) {
    const v = typeof body.latency_ms === 'number' ? Math.round(body.latency_ms) : null
    if (v !== null && v < 0)
      return NextResponse.json({ error: 'latency_ms must be >= 0' }, { status: 400 })
    addField('latency_ms', v)
  }
  if ('bans_detected'      in body) {
    const v = typeof body.bans_detected === 'number' ? Math.round(body.bans_detected) : null
    if (v === null || v < 0)
      return NextResponse.json({ error: 'bans_detected must be a non-negative integer' }, { status: 400 })
    addField('bans_detected', v)
  }
  if ('sticky_line_id'     in body) {
    const v = typeof body.sticky_line_id === 'string' && isUUID(body.sticky_line_id)
      ? body.sticky_line_id : null
    addField('sticky_line_id', v)
  }
  if ('notes'              in body) addField('notes', clampStr(body.notes, 1000))

  if (sets.length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  sets.push(`updated_at = NOW()`)
  values.push(id)

  try {
    const rows = await query<{ id: string }>(
      `UPDATE proxies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id`,
      values
    )
    if (rows.length === 0)
      return NextResponse.json({ error: 'Proxy not found' }, { status: 404 })

    void audit({
      req,
      action:      'proxy.update',
      resource:    'lines',
      resource_id: id,
      status:      'success',
      metadata:    { fields: Object.keys(body) },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/proxies/:id PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────
// Soft delete: marks is_active=false; does NOT remove the row.
// The FK on whatsapp_lines.proxy_id uses ON DELETE SET NULL — but we only
// soft-delete here so the audit trail stays intact.

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) {
    return NextResponse.json({ error: 'id must be a valid UUID' }, { status: 400 })
  }

  try {
    // Detach from any lines currently using this proxy
    await query(
      `UPDATE whatsapp_lines SET proxy_id = NULL, updated_at = NOW() WHERE proxy_id = $1`,
      [id]
    )

    const rows = await query<{ id: string }>(
      `UPDATE proxies SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    )
    if (rows.length === 0)
      return NextResponse.json({ error: 'Proxy not found' }, { status: 404 })

    void audit({
      req,
      action:      'proxy.deactivate',
      resource:    'lines',
      resource_id: id,
      status:      'success',
      metadata:    {},
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/proxies/:id DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
