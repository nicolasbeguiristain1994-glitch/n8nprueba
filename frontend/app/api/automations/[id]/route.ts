import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateAutomationSchema, UpdateOptOutAutomationSchema } from '@/lib/schema'
import { OPT_OUT_AUTOMATION } from '@/lib/opt-out-automation'
import { getOptOutAutomation, saveOptOutMessage } from '@/lib/opt-out-settings'

// ── GET /api/automations/[id] ─────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'read')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id) && id !== OPT_OUT_AUTOMATION.id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  try {
    if (id === OPT_OUT_AUTOMATION.id) return NextResponse.json({ automation: await getOptOutAutomation() })
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
  if (id === OPT_OUT_AUTOMATION.id) {
    const parsed = parseBody(UpdateOptOutAutomationSchema, await req.json().catch(() => null))
    if (!parsed.ok) return handleValidationError(req, parsed.error, 'automations')
    try {
      const automation = await saveOptOutMessage(parsed.data.action_config.message, auth.user.user_id)
      void audit({ req, action: 'update', resource: 'automations', metadata: { system_automation_id: id, fields: ['action_config.message'] } })
      return NextResponse.json({ ok: true, automation })
    } catch (e) {
      console.error('[/api/automations/baja PATCH]', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'No se pudo guardar la respuesta de BAJA' }, { status: 500 })
    }
  }
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateAutomationSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'automations')

  const { name, description, type, trigger_type, trigger_config, action_config, is_active, priority } = parsed.data

  const setClauses: string[] = []
  const queryParams: unknown[] = []
  let p = 0

  if (name          !== undefined) { setClauses.push(`name = $${++p}`);                   queryParams.push(name) }
  if (description   !== undefined) { setClauses.push(`description = $${++p}`);            queryParams.push(description) }
  if (type          !== undefined) { setClauses.push(`type = $${++p}`);                   queryParams.push(type) }
  if (trigger_type  !== undefined) { setClauses.push(`trigger_type = $${++p}`);           queryParams.push(trigger_type) }
  if (trigger_config !== undefined) { setClauses.push(`trigger_config = $${++p}::jsonb`); queryParams.push(JSON.stringify(trigger_config)) }
  if (action_config  !== undefined) { setClauses.push(`action_config = $${++p}::jsonb`);  queryParams.push(JSON.stringify(action_config)) }
  if (is_active     !== undefined) { setClauses.push(`is_active = $${++p}`);              queryParams.push(is_active) }
  if (priority      !== undefined) { setClauses.push(`priority = $${++p}`);               queryParams.push(priority) }

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
      metadata: Object.fromEntries(
        Object.entries(parsed.data).filter(([, v]) => v !== undefined)
      ) })

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
