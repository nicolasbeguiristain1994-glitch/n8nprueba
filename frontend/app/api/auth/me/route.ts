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
  can_download_contacts: boolean
  allowed_agents: string[]
}

export async function GET(req: Request) {
  try {
    const user = requireAuth(req)

    // Bootstrap: only valid while users table is empty
    if (user.user_id === 'bootstrap') {
      const countRows = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users')
      if ((countRows[0]?.count ?? 0) > 0) {
        return Response.json({ error: 'Session expired' }, { status: 401 })
      }
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
      'SELECT id, email, name, role, sectors, is_active, session_version, can_download_contacts, allowed_agents FROM users WHERE id = $1',
      [user.user_id]
    )

    const u = rows[0]

    if (!u || !u.is_active || u.session_version !== user.session_version) {
      return Response.json({ error: 'Session expired' }, { status: 401 })
    }

    return Response.json({
      user: {
        id:                    u.id,
        email:                 u.email,
        name:                  u.name,
        role:                  u.role,
        sectors:               Array.isArray(u.sectors) ? u.sectors : [],
        can_download_contacts: u.can_download_contacts,
        allowed_agents:        Array.isArray(u.allowed_agents) ? u.allowed_agents : [],
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
