import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// GET /api/settings/audit-log
// Paginado. Parámetros: page (default 1), limit (default 20), table_name (filtro opcional).
// Requiere settings:read. Solo lectura; settings_audit_log es append-only.

type AuditLogRow = {
  id: string
  table_name: string
  record_id: string
  operation: 'INSERT' | 'UPDATE'
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown>
  changed_by: string
  changed_at: string
  workspace_id: string
  reason: string | null
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)

  const page      = Math.max(1, parseInt(searchParams.get('page')  ?? '1', 10))
  const limit     = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))
  const tableName = searchParams.get('table_name') ?? null
  const offset    = (page - 1) * limit

  try {
    const [rows, countRows] = await Promise.all([
      query<AuditLogRow>(
        `SELECT id, table_name, record_id, operation,
                old_value, new_value,
                changed_by, changed_at::text AS changed_at,
                workspace_id, reason
         FROM settings_audit_log
         WHERE ($1::text IS NULL OR table_name = $1)
         ORDER BY changed_at DESC
         LIMIT $2 OFFSET $3`,
        [tableName, limit, offset],
      ),
      query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM settings_audit_log
         WHERE ($1::text IS NULL OR table_name = $1)`,
        [tableName],
      ),
    ])

    const total      = countRows[0]?.total ?? 0
    const totalPages = Math.ceil(total / limit)

    return NextResponse.json({
      entries: rows,
      pagination: { page, limit, total, totalPages },
    })
  } catch (e) {
    console.error('[/api/settings/audit-log GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
