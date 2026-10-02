/** One contact audience for reads, imports, mutations and notifications.
 * Explicit assignments narrow allowed agents. With no assignments the agent
 * scope alone applies; an empty allowed_agents list imposes no agent restriction.
 */
import { query } from '@/lib/db'
export type VisibilityRole = 'admin' | 'operator' | 'viewer'
export type ContactAccessUser = { role: VisibilityRole; user_id: string; allowed_agents?: string[] | null }
export function visibilityClause(role: VisibilityRole, userId: string, paramBase: number, alias = 'contacts') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid SQL alias')
  if (role === 'admin') return { sql: '', params: [] as unknown[] }
  return { sql: ` AND (EXISTS (SELECT 1 FROM operator_contact_visibility ocv
    WHERE ocv.contact_id=${alias}.id AND ocv.operator_id=$${paramBase + 1})
    OR NOT EXISTS (SELECT 1 FROM operator_contact_visibility WHERE operator_id=$${paramBase + 1}))`, params: [userId] as unknown[] }
}
export function contactScope(user: ContactAccessUser, paramBase = 0, alias = 'contacts') {
  const vis = visibilityClause(user.role, user.user_id, paramBase, alias)
  let sql = `${alias}.deleted_at IS NULL${vis.sql}`
  const params = [...vis.params]
  if (user.role !== 'admin' && user.allowed_agents?.length) {
    params.push(user.allowed_agents)
    sql += ` AND ${alias}.panel = ANY($${paramBase + params.length}::text[])`
  }
  return { sql, params }
}
export function canAssignPanels(user: ContactAccessUser, panels: (string | null)[]) {
  return user.role === 'admin' || !user.allowed_agents?.length
    || panels.every(panel => panel !== null && user.allowed_agents!.includes(panel))
}
export async function canSeeContact(user: ContactAccessUser, contactId: string): Promise<boolean> {
  const scope = contactScope(user, 1)
  const rows = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM contacts WHERE id=$1 AND ${scope.sql}) AS exists`, [contactId, ...scope.params])
  return rows[0]?.exists ?? false
}
/** Phone aliases must not expose a hidden/deleted contact via another row. */
export function contactPhoneScope(user: ContactAccessUser, phoneSql: string, paramBase: number, allowUnknown: boolean) {
  const scope = contactScope(user, paramBase, 'contact_scope')
  const matching = `REPLACE(contact_scope.phone_number,'+','')=REPLACE(${phoneSql},'+','')`
  return { sql: `(NOT EXISTS (SELECT 1 FROM contacts contact_scope WHERE ${matching}
      AND (${scope.sql}) IS NOT TRUE)${allowUnknown ? '' : ` AND EXISTS (SELECT 1 FROM contacts contact_scope WHERE ${matching})`})`, params: scope.params }
}
/** Keep newly created contacts visible without turning an unrestricted user into
 * an explicitly restricted user by inserting their first assignment. */
export async function grantCreatedContacts(client: { query(sql: string, params: unknown[]): Promise<unknown> }, user: ContactAccessUser, ids: string[]) {
  if (user.role === 'admin' || !ids.length) return
  await client.query(`INSERT INTO operator_contact_visibility(operator_id,contact_id,assigned_by)
    SELECT $1, unnest($2::uuid[]), $1
    WHERE EXISTS (SELECT 1 FROM operator_contact_visibility WHERE operator_id=$1)
    ON CONFLICT(operator_id,contact_id) DO NOTHING`, [user.user_id, ids])
}

// ── Asignación bulk ───────────────────────────────────────────────────────────

/**
 * Asigna un conjunto de contactos a un operador.
 * Ignora duplicados (ON CONFLICT DO NOTHING).
 *
 * @returns Cantidad de filas realmente insertadas
 */
export async function assignContacts(
  operatorId: string,
  contactIds: string[],
  assignedBy: string,
): Promise<number> {
  if (contactIds.length === 0) return 0

  const rows = await query<{ count: string }>(
    `WITH ins AS (
       INSERT INTO operator_contact_visibility (operator_id, contact_id, assigned_by)
       SELECT $1, unnest($2::uuid[]), $3
       ON CONFLICT (operator_id, contact_id) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM ins`,
    [operatorId, contactIds, assignedBy],
  )
  return Number(rows[0]?.count ?? 0)
}

/**
 * Quita visibilidad de un conjunto de contactos para un operador.
 *
 * @returns Cantidad de filas eliminadas
 */
export async function unassignContacts(
  operatorId: string,
  contactIds: string[],
): Promise<number> {
  if (contactIds.length === 0) return 0

  const rows = await query<{ count: string }>(
    `WITH del AS (
       DELETE FROM operator_contact_visibility
       WHERE operator_id = $1 AND contact_id = ANY($2::uuid[])
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM del`,
    [operatorId, contactIds],
  )
  return Number(rows[0]?.count ?? 0)
}

/**
 * Asigna TODOS los contactos que cumplan un filtro opcional al operador.
 * Útil para asignación masiva por panel, segmento, etc.
 *
 * @param operatorId  Operador destino
 * @param assignedBy  Admin que realiza la asignación
 * @param filter      Filtros opcionales (panel, segment, linea)
 * @returns Cantidad de filas insertadas
 */
export async function assignAllByFilter(
  operatorId: string,
  assignedBy: string,
  filter: { panel?: string; segment?: string; linea?: number } = {},
): Promise<number> {
  const conditions: string[] = []
  const params: unknown[] = [operatorId, assignedBy]
  let p = 2

  if (filter.panel) {
    conditions.push(`panel = $${++p}`)
    params.push(filter.panel)
  }
  if (filter.segment) {
    conditions.push(`segment::text = $${++p}`)
    params.push(filter.segment)
  }
  if (filter.linea) {
    conditions.push(`linea = $${++p}`)
    params.push(filter.linea)
  }

  const whereExtra = conditions.length ? `AND ${conditions.join(' AND ')}` : ''

  const rows = await query<{ count: string }>(
    `WITH ins AS (
       INSERT INTO operator_contact_visibility (operator_id, contact_id, assigned_by)
       SELECT $1, id, $2
       FROM contacts
       WHERE TRUE ${whereExtra}
       ON CONFLICT (operator_id, contact_id) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM ins`,
    params,
  )
  return Number(rows[0]?.count ?? 0)
}

/**
 * Quita TODOS los contactos asignados al operador.
 */
export async function unassignAll(operatorId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH del AS (
       DELETE FROM operator_contact_visibility WHERE operator_id = $1 RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM del`,
    [operatorId],
  )
  return Number(rows[0]?.count ?? 0)
}
