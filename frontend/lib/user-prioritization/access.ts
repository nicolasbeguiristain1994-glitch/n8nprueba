import { contactScope, type VisibilityRole } from '@/lib/contact-visibility'

export interface PriorityAccess {
  role: VisibilityRole
  userId: string
  allowedAgents?: string[]
}

// Reuse Contacts visibility and agent scope in reads and writes.
export function priorityAccess(access: PriorityAccess | undefined, offset: number) {
  if (!access) return { sql: '', params: [] as unknown[] } // internal jobs only
  const scope = contactScope({role: access.role, user_id: access.userId, allowed_agents: access.allowedAgents}, offset, 'c')
  return { sql: ` AND ${scope.sql}`, params: scope.params }
}
