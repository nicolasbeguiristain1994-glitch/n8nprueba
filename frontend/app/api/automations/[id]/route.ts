import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID, clampStr } from '@/lib/validate'
import { audit } from '@/lib/audit'

// ── GET /api/automations/[id] ─────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'read')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  try {
    const rows = await query(
      `SELECT a.*, u.name AS created_by_name
       FROM automations a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.id = $1`,
      [id],
    )
    if (!rows[0]) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    return NextResponse.json({ automation: rows[0] })
  } catch (e) {
    console.error('[/api/automations/[id] GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

// ── PATCH /api/automations/[id] ───────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const setClauses: string[] = []
  const queryParams: unknown[] = []
  let p = 0

  if ('name' in body) {
    const name = clampStr(body.name, 200)
    if (!name) return NextResponse.json({ error: 'Nombre inválido' }, { status: 400 })
    setClauses.push(`name = $${++p}`)
    queryParams.push(name)
  }
  if ('description' in body) {
    setClauses.push(`description = $${++p}`)
    queryParams.push(clampStr(body.description, 500))
  }
  if ('type' in body) {
    if (!['reply', 'flow', 'handoff'].includes(body.type as string)) {
      return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })
    }
    setClauses.push(`type = $${++p}`)
    queryParams.push(body.type)
  }
  if ('trigger_type' in body) {
    if (!['keyword', 'contains', 'any_inbound'].includes(body.trigger_type as string)) {
      return NextResponse.json({ error: 'Tipo de trigger inválido' }, { status: 400 })
    }
    setClauses.push(`trigger_type = $${++p}`)
    queryParams.push(body.trigger_type)
  }
  if ('trigger_config' in body) {
    setClauses.push(`trigger_config = $${++p}::jsonb`)
    queryParams.push(JSON.stringify(body.trigger_config))
  }
  if ('action_config' in body) {
    setClauses.push(`action_config = $${++p}::jsonb`)
    queryParams.push(JSON.stringify(body.action_config))
  }
  if ('is_active' in body) {
    setClauses.push(`is_active = $${++p}`)
    queryParams.push(Boolean(body.is_active))
  }
  if ('priority' in body) {
    const prio = typeof body.priority === 'number' ? Math.max(1, Math.min(1000, body.priority)) : 100
    setClauses.push(`priority = $${++p}`)
    queryParams.push(prio)
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: 'Sin campos para actualizar' }, { status: 400 })
  }

  setClauses.push(`updated_at = NOW()`)
  queryParams.push(id)

  try {
    const rows = await query<{ id: string }>(
      `UPDATE automations SET ${setClauses.join(', ')} WHERE id = $${p + 1} RETURNING id`,
      queryParams,
    )
    if (!rows[0]) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    void audit({ req, action: 'update', resource: 'automations' as never, resource_id: id,
      metadata: Object.fromEntries(Object.keys(body).map(k => [k, body[k]])) })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/automations/[id] PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

// ── DELETE /api/automations/[id] ──────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  try {
    const rows = await query<{ id: string }>(
      `DELETE FROM automations WHERE id = $1 RETURNING id`,
      [id],
    )
    if (!rows[0]) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    void audit({ req, action: 'delete', resource: 'automations' as never, resource_id: id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/automations/[id] DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
