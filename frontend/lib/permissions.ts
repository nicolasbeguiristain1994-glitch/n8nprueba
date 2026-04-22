import { getSessionFromRequest, type SessionUser } from './auth'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Resource =
  | 'dashboard'
  | 'contacts'
  | 'campaigns'
  | 'conversations'
  | 'lines'
  | 'warmup'
  | 'lists'   // contact lists (create lists, assign contacts)
  | 'send'    // manual one-off send (/api/send)
  | 'users'
  | 'settings'

export type Action = 'read' | 'create' | 'update' | 'delete' | 'send' | 'manage'

export type { SessionUser }

// ── All known resources and actions (used for permission introspection) ───────

export const ALL_RESOURCES: Resource[] = [
  'dashboard', 'contacts', 'campaigns', 'conversations',
  'lines', 'warmup', 'lists', 'send', 'users', 'settings',
]

export const ALL_ACTIONS: Action[] = ['read', 'create', 'update', 'delete', 'send', 'manage']

// ── Permission matrix ─────────────────────────────────────────────────────────
//
// admin    → full access to everything
// operator → read/create/update/send on non-admin resources, scoped to sectors
//            cannot: delete, manage, touch users/settings
// viewer   → read only on resources in their sectors
//
// sectors (JSONB array on users row) scope non-admin access.
// An operator/viewer with sectors=[] has no access beyond what role allows globally.

export function canAccess(user: Pick<SessionUser, 'role' | 'sectors'>, resource: Resource, action: Action): boolean {
  if (user.role === 'admin') return true

  if (user.role === 'viewer') {
    if (action !== 'read') return false
    return user.sectors.includes(resource)
  }

  if (user.role === 'operator') {
    // Hard blocks regardless of sectors
    if (resource === 'users' || resource === 'settings') return false
    if (action === 'manage' || action === 'delete') return false
    // Allowed actions for operators
    if (!(['read', 'create', 'update', 'send'] as Action[]).includes(action)) return false
    return user.sectors.includes(resource)
  }

  return false
}

// ── Effective permissions helper (used by /api/auth/me) ───────────────────────

/** Returns a map of resource → allowed actions for the given user (role + sectors only). */
export function effectivePermissions(user: Pick<SessionUser, 'role' | 'sectors'>): Partial<Record<Resource, Action[]>> {
  const result: Partial<Record<Resource, Action[]>> = {}
  for (const resource of ALL_RESOURCES) {
    const allowed = ALL_ACTIONS.filter(a => canAccess(user, resource, a))
    if (allowed.length > 0) result[resource] = allowed
  }
  return result
}

// ── Non-throwing guards (return Response | null) ─────────────────────────────
// Prefer these in Route Handlers where the function already has its own
// try/catch — no restructuring needed, just an early-return check.
//
// Phase 2 RBAC: swap checkAuth() → checkRole(req, 'admin') / checkPermission()
// in any route that needs finer-grained control.

/** Returns a 401 Response if the request has no valid session, null otherwise. */
export function checkAuth(req: Request): Response | null {
  const user = getSessionFromRequest(req)
  if (!user) return unauth()
  return null
}

/**
 * Returns 401/403 if the caller is not authenticated or lacks the permission.
 * Preferred pattern for route handlers:
 *   const err = checkPermission(req, 'campaigns', 'create')
 *   if (err) return err
 */
export function checkPermission(req: Request, resource: Resource, action: Action): Response | null {
  const user = getSessionFromRequest(req)
  if (!user) return unauth()
  if (!canAccess(user, resource, action)) return forbidden(resource, action)
  return null
}

/** Returns 401/403 if the caller does not have one of the required roles. */
export function checkRole(req: Request, ...roles: Array<SessionUser['role']>): Response | null {
  const user = getSessionFromRequest(req)
  if (!user) return unauth()
  if (!roles.includes(user.role)) {
    return new Response(
      JSON.stringify({ error: `Forbidden: requires role ${roles.join(' or ')}` }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return null
}

// ── Private response builders ─────────────────────────────────────────────────

function unauth(): Response {
  return new Response(
    JSON.stringify({ error: 'Unauthorized' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  )
}

// resource/action params kept for call-site symmetry; not included in response
// to avoid leaking internal permission details to callers.
function forbidden(_resource: Resource, _action: Action): Response {
  return new Response(
    JSON.stringify({ error: 'Forbidden' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  )
}

// ── Throwing guards (throw Response on failure) ────────────────────────────

export function requireAuth(req: Request): SessionUser {
  const user = getSessionFromRequest(req)
  if (!user) throw unauth()
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
  if (!canAccess(user, resource, action)) throw forbidden(resource, action)
  return user
}
