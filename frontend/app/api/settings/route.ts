import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

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

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 })
  }

  if (typeof body !== 'object' || Array.isArray(body) || body === null) {
    return NextResponse.json({ error: 'El cuerpo debe ser un objeto' }, { status: 400 })
  }

  const entries = Object.entries(body)
  if (entries.length === 0) {
    return NextResponse.json({ error: 'No hay campos para actualizar' }, { status: 400 })
  }

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

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/settings PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
