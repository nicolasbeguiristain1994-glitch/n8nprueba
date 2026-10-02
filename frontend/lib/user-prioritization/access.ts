import { visibilityClause, type VisibilityRole } from '@/lib/contact-visibility'

export interface PriorityAccess {
  role: VisibilityRole
  userId: string
  allowedAgents?: string[]
}

// Reuse Contacts visibility and agent scope in reads and writes.
export function priorityAccess(access: PriorityAccess | undefined, offset: number) {
  if (!access) return { sql: '', params: [] as unknown[] } // internal jobs only
  const vis = visibilityClause(access.role, access.userId, offset, 'c')
  const params: unknown[] = [...vis.params]
  let sql = vis.sql
  if (access.role !== 'admin' && access.allowedAgents?.length) {
    params.push(access.allowedAgents)
    sql += ` AND c.panel = ANY($${offset + params.length}::text[])`
  }
  return { sql, params }
}
