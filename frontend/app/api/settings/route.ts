import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateSettingsSchema } from '@/lib/schema'

type SettingRow = {
  key: string
  value: unknown
  type: string
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const rows = await query<SettingRow>(
      `SELECT key, value, type FROM app_settings ORDER BY key`
    )
    const settings: Record<string, unknown> = {}
    for (const r of rows) {
      settings[r.key] = r.value
    }
    return NextResponse.json({ settings })
  } catch (e) {
    console.error('[/api/settings GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateSettingsSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'settings')

  const entries = Object.entries(parsed.data)

  try {
    const existingRows = await query<{ key: string; type: string }>(
      `SELECT key, type FROM app_settings`
    )
    const existing = new Map(existingRows.map(r => [r.key, r.type]))

    for (const [key] of entries) {
      if (!existing.has(key)) {
        return NextResponse.json({ error: `Clave desconocida: "${key}"` }, { status: 400 })
      }
    }

    for (const [key, value] of entries) {
      await query(
        `UPDATE app_settings SET value = $1::jsonb, updated_at = NOW(), updated_by = $2 WHERE key = $3`,
        [JSON.stringify(value), auth.user.user_id, key]
      )
    }

    void audit({ req, action: 'update', resource: 'settings',
      metadata: { keys: Object.keys(parsed.data) } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/settings PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
