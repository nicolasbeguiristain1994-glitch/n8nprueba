import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

type AgentRow = {
  id: string
  name: string | null
  email: string
}

// ── GET /api/tickets/agents ───────────────────────────────────────────────────
// Returns the list of active users who can be assigned/transferred tickets.
//
// Access: any user with tickets:read (admin, operator with tickets sector,
//   viewer with tickets sector). Does NOT expose full user management data.
//
// Response: { agents: [{ id, name, email }] }
//
// Includes all active admin users plus active operators who have 'tickets'
// in their sectors — the same set that can act on tickets.

export async function GET(req: Request) {
  const err = await checkPermission(req, 'tickets', 'read')
  if (err) return err

  try {
    const rows = await query<AgentRow>(
      `SELECT id, name, email
       FROM users
       WHERE is_active = true
         AND (
           role = 'admin'
           OR (role = 'operator' AND sectors @> '["tickets"]'::jsonb)
         )
       ORDER BY name ASC NULLS LAST, email ASC`,
    )

    return NextResponse.json({ agents: rows })
  } catch (e) {
    console.error('[GET /api/tickets/agents]', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
