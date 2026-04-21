import { getSessionFromRequest, type SessionUser } from './auth'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Resource = 'dashboard' | 'contacts' | 'campaigns' | 'conversations' | 'lines' | 'warmup' | 'users' | 'settings'
export type Action   = 'read' | 'create' | 'update' | 'delete' | 'send' | 'manage'

export type { SessionUser }

// ── Permission logic ──────────────────────────────────────────────────────────

export function canAccess(user: SessionUser, resource: Resource, action: Action): boolean {
  if (user.role === 'admin') {
    // admin: all resources, all actions
    return true
  }

  if (user.role === 'viewer') {
    // viewer: only read, and only for resources in their sectors
    if (action !== 'read') return false
    return user.sectors.includes(resource)
  }

  if (user.role === 'operator') {
    // operator: no users or settings management
    if (resource === 'users' || resource === 'settings') return false
    // operator: no manage or delete
    if (action === 'manage' || action === 'delete') return false
    // operator: resource must be in their sectors, and action must be allowed
    const allowedActions: Action[] = ['read', 'create', 'update', 'send']
    if (!allowedActions.includes(action)) return false
    return user.sectors.includes(resource)
  }

  return false
}

// ── Auth guard helpers (throw Response on failure) ────────────────────────────

export function requireAuth(req: Request): SessionUser {
  const user = getSessionFromRequest(req)
  if (!user) {
    throw new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return user
}

export function requireAdmin(req: Request): SessionUser {
  const user = requireAuth(req)
  if (user.role !== 'admin') {
    throw new Response(
      JSON.stringify({ error: 'Forbidden: admin role required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return user
}

export function requirePermission(req: Request, resource: Resource, action: Action): SessionUser {
  const user = requireAuth(req)
  if (!canAccess(user, resource, action)) {
    throw new Response(
      JSON.stringify({ error: `Forbidden: cannot ${action} ${resource}` }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return user
}
