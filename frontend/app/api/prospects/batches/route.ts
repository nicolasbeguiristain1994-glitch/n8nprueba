import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// GET /api/prospects/batches — historial de importaciones
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  try {
    const rows = await query(
      `SELECT
         id, filename, total_rows, imported, skipped_duplicates,
         skipped_invalid, warned_existing_contacts, notes, created_at
       FROM prospect_import_batches
       ORDER BY created_at DESC
       LIMIT 50`
    )
    return NextResponse.json({ batches: rows })
  } catch (e) {
    console.error('[GET /api/prospects/batches]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
