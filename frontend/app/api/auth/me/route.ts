import { query } from '@/lib/db'
import { requireAuth, effectivePermissions } from '@/lib/permissions'

type UserRow = {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'operator' | 'viewer'
  sectors: string[]
  is_active: boolean
  session_version: number
}

export async function GET(req: Request) {
  try {
    const user = requireAuth(req)

    // Bootstrap shortcut — no DB query needed
    if (user.user_id === 'bootstrap') {
      return Response.json({
        user: {
          id:      'bootstrap',
          email:   user.email,
          name:    user.name,
          role:    user.role,
          sectors: user.sectors,
        },
        permissions: effectivePermissions(user),
      })
    }

    // Re-fetch from DB to get fresh is_active and session_version
    const rows = await query<UserRow>(
      'SELECT id, email, name, role, sectors, is_active, session_version FROM users WHERE id = $1',
      [user.user_id]
    )

    const u = rows[0]

    if (!u || !u.is_active || u.session_version !== user.session_version) {
      return Response.json({ error: 'Session expired' }, { status: 401 })
    }

    return Response.json({
      user: {
        id:      u.id,
        email:   u.email,
        name:    u.name,
        role:    u.role,
        sectors: Array.isArray(u.sectors) ? u.sectors : [],
      },
      // Permissions derived from fresh DB role/sectors — not from stale session token
      permissions: effectivePermissions({
        role:    u.role,
        sectors: Array.isArray(u.sectors) ? u.sectors : [],
      }),
    })
  } catch (e) {
    if (e instanceof Response) return e
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
