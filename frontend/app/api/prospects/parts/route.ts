import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// GET /api/prospects/parts?batch_id=X
// Returns distinct part numbers (from "parte:N" tags) for a given batch (or all prospects)
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  const batchId = req.nextUrl.searchParams.get('batch_id') || ''

  try {
    const rows = await query(
      `SELECT DISTINCT tag
       FROM prospects, unnest(tags) AS tag
       WHERE tag ~ '^parte:[0-9]+$'
         AND ($1 = '' OR import_batch_id::text = $1)
       ORDER BY tag`,
      [batchId]
    ) as { tag: string }[]

    const parts = rows
      .map(r => Number(r.tag.replace('parte:', '')))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b)

    return NextResponse.json({ parts })
  } catch (e) {
    console.error('[GET /api/prospects/parts]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
