import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, CreateAutomationSchema } from '@/lib/schema'

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

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateAutomationSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'automations')

  const { name, description, type, trigger_type: triggerType,
          trigger_config: triggerConfig, action_config: actionConfig,
          is_active, priority } = parsed.data

  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO automations
         (name, description, type, trigger_type, trigger_config, action_config, is_active, priority, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        name, description, type, triggerType,
        JSON.stringify(triggerConfig), JSON.stringify(actionConfig),
        is_active,
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
