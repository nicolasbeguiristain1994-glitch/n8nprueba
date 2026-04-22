import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'

export async function GET(req: NextRequest) {
  // Admin only — audit is always restricted to admin in canAccess
  const err = await checkPermission(req, 'audit', 'read')
  if (err) return err

  const url = new URL(req.url)

  const rawLimit  = parseInt(url.searchParams.get('limit')    || '50', 10)
  const limit     = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit))
  const resource  = url.searchParams.get('resource')  || ''
  const action    = url.searchParams.get('action')    || ''
  const userId    = url.searchParams.get('user_id')   || ''
  const status    = url.searchParams.get('status')    || ''

  // Validate user_id if provided to avoid a SQL cast error
  if (userId && !isUUID(userId)) {
    return NextResponse.json({ error: 'user_id must be a valid UUID' }, { status: 400 })
  }

  const conditions: string[] = []
  const params: unknown[]    = []
  let pi = 1

  if (resource) { conditions.push(`resource = $${pi++}`);          params.push(resource) }
  if (action)   { conditions.push(`action   = $${pi++}`);          params.push(action) }
  if (userId)   { conditions.push(`user_id  = $${pi++}::uuid`);    params.push(userId) }
  if (status)   { conditions.push(`status   = $${pi++}`);          params.push(status) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(limit)

  try {
    const rows = await query(
      `SELECT id, user_id, user_email, user_role, action, resource, resource_id,
              status, ip_address, user_agent, metadata, created_at
       FROM   rbac_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT  $${pi}`,
      params
    )
    return NextResponse.json({ events: rows, count: rows.length })
  } catch (e) {
    console.error('[GET /api/audit]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
