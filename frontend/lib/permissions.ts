import { NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import type { SessionUser } from '@/lib/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Resource =
  | 'dashboard'
  | 'contacts'
  | 'campaigns'
  | 'conversations'
  | 'lines'
  | 'warmup'
  | 'users'
  | 'lists'
  | 'send'
  | 'audit'
  | 'settings'

export type Action = 'read' | 'create' | 'update' | 'delete' | 'manage' | 'send'

// Permissions are returned as arrays of allowed actions per resource.
// e.g. { campaigns: ['read', 'create', 'update', 'send'], users: ['read', 'create', 'update', 'delete', 'manage'] }
export type EffectivePermissions = Partial<Record<Resource, Action[]>>

// ── RBAC matrix ───────────────────────────────────────────────────────────────
//
// admin    → all resources, all actions
// operator → read / create / update / send on assigned sectors; never delete or manage
// viewer   → read only on assigned sectors

/**
 * Check whether a user (or partial role+sectors object) can perform an action
 * on a resource.
 */
export function canAccess(
  user: Pick<SessionUser, 'role' | 'sectors'>,
  resource: Resource,
  action: Action,
): boolean {
  if (user.role === 'admin') return true

  // delete and manage are always admin-only
  if (action === 'delete' || action === 'manage') return false

  const sectors: string[] = Array.isArray(user.sectors) ? user.sectors : []

  // users and audit management are always admin-only
  if (resource === 'users' || resource === 'audit') return false

  // sector check — operator/viewer must have the resource in their sectors
  if (!sectors.includes(resource)) return false

  if (user.role === 'viewer') {
    return action === 'read'
  }

  // operator
  if (user.role === 'operator') {
    return action === 'read' || action === 'create' || action === 'update' || action === 'send'
  }

  return false
}

/**
 * Return a map of resource → action → boolean for the given user.
 * Used by /api/auth/me to expose permissions to the frontend.
 */
export function effectivePermissions(
  user: Pick<SessionUser, 'role' | 'sectors'>,
): EffectivePermissions {
  const resources: Resource[] = [
    'dashboard', 'contacts', 'campaigns', 'conversations',
    'lines', 'warmup', 'users', 'lists', 'send', 'audit', 'settings',
  ]
  const actions: Action[] = ['read', 'create', 'update', 'delete', 'manage', 'send']

  const out: EffectivePermissions = {}
  for (const resource of resources) {
    const allowed = actions.filter(action => canAccess(user, resource, action))
    if (allowed.length > 0) {
      out[resource] = allowed
    }
  }
  return out
}

/**
 * Synchronous permission check for use in API route handlers.
 *
 * Returns null if access is allowed, or a NextResponse (401/403) if not.
 *
 * Usage:
 *   const err = checkPermission(req, 'warmup', 'read')
 *   if (err) return err
 */
export function checkPermission(
  req: Request,
  resource: Resource,
  action: Action,
): NextResponse | null {
  const session = getSessionFromRequest(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccess(session, resource, action)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

/**
 * Throw a Response if the request has no valid session.
 * Returns the SessionUser on success.
 *
 * Usage (in try/catch — catch (e) { if (e instanceof Response) return e }):
 *   const user = requireAuth(req)
 */
export function requireAuth(req: Request): SessionUser {
  const session = getSessionFromRequest(req)
  if (!session) {
    throw Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return session
}

/**
 * Generic row-level ownership check.
 *
 * Rules (same for every owned resource):
 *   admin              → always true (sees all rows, including historical NULL-owned)
 *   ownedBy === null   → false for non-admin (historical rows are admin-only)
 *   ownedBy === userId → true  (own row)
 *   ownedBy !== userId → false (someone else's row)
 *
 * Used by campaign and contact_list routes; extend to future resources as needed.
 */
export function isOwnerOrAdmin(
  user: Pick<SessionUser, 'role' | 'user_id'>,
  ownedBy: string | null,
): boolean {
  if (user.role === 'admin') return true
  if (ownedBy === null) return false  // historical — admin-only
  return ownedBy === user.user_id
}

/**
 * Alias kept for backwards compatibility — campaign routes and existing tests
 * reference this name.
 */
export const isCampaignOwnerOrAdmin = isOwnerOrAdmin
