import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { clampStr } from '@/lib/validate'
import { audit } from '@/lib/audit'

type AutomationRow = {
  id: string
  name: string
  description: string | null
  type: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  action_config: Record<string, unknown>
  is_active: boolean
  priority: number
  created_by: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

// ── GET /api/automations ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)
  const q      = searchParams.get('q')?.trim() ?? ''
  const type   = searchParams.get('type') ?? ''
  const status = searchParams.get('status') ?? ''

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 0

  if (q) {
    conditions.push(`a.name ILIKE $${++p}`)
    params.push(`%${q}%`)
  }
  if (type && ['reply', 'flow', 'handoff'].includes(type)) {
    conditions.push(`a.type = $${++p}`)
    params.push(type)
  }
  if (status === 'active') {
    conditions.push('a.is_active = true')
  } else if (status === 'paused') {
    conditions.push('a.is_active = false')
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const rows = await query<AutomationRow>(
      `SELECT a.id, a.name, a.description, a.type, a.trigger_type,
              a.trigger_config, a.action_config, a.is_active, a.priority,
              a.created_by, a.created_at, a.updated_at,
              u.name AS created_by_name
       FROM automations a
       LEFT JOIN users u ON u.id = a.created_by
       ${where}
       ORDER BY a.priority ASC, a.created_at ASC`,
      params,
    )
    return NextResponse.json({ automations: rows })
  } catch (e) {
    console.error('[/api/automations GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

// ── POST /api/automations ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'manage')
  if (!auth.ok) return auth.response
  const session = auth.user

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const name = clampStr(body.name, 200)
  if (!name) return NextResponse.json({ error: 'El nombre es requerido' }, { status: 400 })

  const type = body.type as string
  if (!['reply', 'flow', 'handoff'].includes(type)) {
    return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })
  }

  const triggerType = body.trigger_type as string
  if (!['keyword', 'contains', 'any_inbound'].includes(triggerType)) {
    return NextResponse.json({ error: 'Tipo de trigger inválido' }, { status: 400 })
  }

  const triggerConfig = body.trigger_config ?? {}
  const actionConfig  = body.action_config  ?? {}
  const description   = clampStr(body.description, 500)
  const priority      = typeof body.priority === 'number' ? Math.max(1, Math.min(1000, body.priority)) : 100

  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO automations
         (name, description, type, trigger_type, trigger_config, action_config, is_active, priority, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        name, description, type, triggerType,
        JSON.stringify(triggerConfig), JSON.stringify(actionConfig),
        body.is_active !== false,
        priority,
        session.user_id,
      ],
    )

    void audit({ req, action: 'create', resource: 'automations' as never, resource_id: rows[0].id,
      metadata: { name, type, triggerType } })

    return NextResponse.json({ id: rows[0].id }, { status: 201 })
  } catch (e) {
    console.error('[/api/automations POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
