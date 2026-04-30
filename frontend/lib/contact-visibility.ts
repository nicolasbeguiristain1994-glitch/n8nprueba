/**
 * contact-visibility.ts
 *
 * Helper central para el filtro de visibilidad de contactos por operador.
 * Usado en:
 *   - GET  /api/contacts
 *   - GET  /api/contacts/[id]  (check individual)
 *   - PATCH/DELETE /api/contacts/[id]
 *   - GET  /api/dashboard
 *   - GET  /api/users/[id]/visibility
 *
 * Reglas de negocio:
 *   - admin          → ve todo, sin filtro
 *   - operator/viewer → solo los contactos en operator_contact_visibility
 *   - Sin filas asignadas → ve 0 contactos
 */

import { query } from '@/lib/db'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type VisibilityRole = 'admin' | 'operator' | 'viewer'

/**
 * Fragmento SQL que se inyecta en el WHERE de cualquier query sobre contacts.
 *
 * @param role       Rol del usuario actual
 * @param userId     ID del usuario actual
 * @param paramBase  Índice del último parámetro ya usado en la query principal
 *                   (para numerar $N correctamente)
 * @param alias      Alias de la tabla contacts en la query (default 'contacts')
 *
 * Devuelve:
 *   sql    → fragmento "AND EXISTS (...)" o "" si admin
 *   params → parámetros adicionales a concatenar al array de la query
 */
export function visibilityClause(
  role: VisibilityRole,
  userId: string,
  paramBase: number,
  alias = 'contacts',
): { sql: string; params: string[] } {
  if (role === 'admin') {
    return { sql: '', params: [] }
  }

  return {
    sql: `
      AND EXISTS (
        SELECT 1 FROM operator_contact_visibility ocv
        WHERE ocv.contact_id = ${alias}.id
          AND ocv.operator_id = $${paramBase + 1}
      )`,
    params: [userId],
  }
}

// ── Check individual ──────────────────────────────────────────────────────────

/**
 * Verifica si el usuario actual puede ver un contacto específico.
 * Admins siempre pueden. Operadores/viewers solo si tienen la fila en la tabla.
 *
 * @returns true si tiene acceso, false si no
 */
export async function canSeeContact(
  role: VisibilityRole,
  userId: string,
  contactId: string,
): Promise<boolean> {
  if (role === 'admin') return true

  const rows = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM operator_contact_visibility
       WHERE operator_id = $1 AND contact_id = $2
     ) AS exists`,
    [userId, contactId],
  )
  return rows[0]?.exists ?? false
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
