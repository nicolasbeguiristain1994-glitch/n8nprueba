// GET  /api/proxies  — list all active proxies with their assigned line count
// POST /api/proxies  — create a new proxy
//
// GET  requires: lines:read
// POST requires: lines:update (admin / operator with lines sector)

import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { clampStr, isUUID } from '@/lib/validate'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const err = await checkPermissionWithUser(req, 'lines', 'read')
  if (!err.ok) return err.response

  const url       = new URL(req.url)
  const activeOnly = url.searchParams.get('active') !== 'false'

  try {
    const rows = await query(`
      SELECT
        p.*,
        COUNT(wl.id)::int AS assigned_lines
      FROM proxies p
      LEFT JOIN whatsapp_lines wl ON wl.proxy_id = p.id
      ${activeOnly ? 'WHERE p.is_active = true' : ''}
      GROUP BY p.id
      ORDER BY p.label ASC
    `)
    return NextResponse.json({ proxies: rows })
  } catch (e) {
    console.error('[/api/proxies GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

type CreateProxyBody = {
  label:              string
  host:               string
  port:               number
  protocol?:          string
  username?:          string | null
  password_ref?:      string | null
  country?:           string | null
  region?:            string | null
  city?:              string | null
  provider?:          string | null
  proxy_type?:        string
  rotating_endpoint?: boolean
  sticky_line_id?:    string | null
  notes?:             string | null
}

const VALID_PROTOCOLS  = new Set(['http', 'https', 'socks5'])
const VALID_PROXY_TYPES = new Set(['datacenter', 'residential', 'mobile'])

export async function POST(req: Request) {
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) return auth.response

  let body: Partial<CreateProxyBody>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Validate required fields
  const label = clampStr(body.label, 100)
  const host  = clampStr(body.host,  255)
  const port  = typeof body.port === 'number' ? Math.round(body.port) : null

  if (!label) return NextResponse.json({ error: 'label is required' }, { status: 400 })
  if (!host)  return NextResponse.json({ error: 'host is required' },  { status: 400 })
  if (!port || port < 1 || port > 65535)
    return NextResponse.json({ error: 'port must be an integer between 1 and 65535' }, { status: 400 })

  const protocol  = body.protocol ?? 'http'
  const proxyType = body.proxy_type ?? 'datacenter'
  if (!VALID_PROTOCOLS.has(protocol))
    return NextResponse.json({ error: `protocol must be one of: ${[...VALID_PROTOCOLS].join(', ')}` }, { status: 400 })
  if (!VALID_PROXY_TYPES.has(proxyType))
    return NextResponse.json({ error: `proxy_type must be one of: ${[...VALID_PROXY_TYPES].join(', ')}` }, { status: 400 })

  const stickyLineId = typeof body.sticky_line_id === 'string' && isUUID(body.sticky_line_id)
    ? body.sticky_line_id : null

  try {
    const rows = await query<{ id: string }>(`
      INSERT INTO proxies
        (label, host, port, protocol, username, password_ref,
         country, region, city, provider, proxy_type, rotating_endpoint,
         sticky_line_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id
    `, [
      label,
      host,
      port,
      protocol,
      clampStr(body.username, 100),
      clampStr(body.password_ref, 500),
      clampStr(body.country, 2)?.toUpperCase() ?? null,
      clampStr(body.region, 50),
      clampStr(body.city, 50),
      clampStr(body.provider, 100),
      proxyType,
      body.rotating_endpoint === true,
      stickyLineId,
      clampStr(body.notes, 1000),
    ])

    void audit({
      req,
      action:      'proxy.create',
      resource:    'lines',
      resource_id: rows[0].id,
      status:      'success',
      metadata:    { label, host, port, protocol, proxy_type: proxyType },
    })

    return NextResponse.json({ id: rows[0].id }, { status: 201 })
  } catch (e) {
    console.error('[/api/proxies POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
