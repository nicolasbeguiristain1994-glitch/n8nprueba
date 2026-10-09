import type { PoolClient } from 'pg'

export type ManagedUser = {
  id: string
  role: string
  sectors: string[]
  is_active: boolean
  session_version: number
}

/** Serialize access changes, then read the target's current state under lock. */
export async function lockManagedUser(client: PoolClient, id: string): Promise<ManagedUser> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wa-platform:user-management'))")
  const { rows } = await client.query<ManagedUser>(
    'SELECT id, role, sectors, is_active, session_version FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
  if (!rows[0]) throw Response.json({ error: 'Usuario no encontrado' }, { status: 404 })
  return rows[0]
}

export async function protectLastAdmin(client: PoolClient, current: ManagedUser, removesAccess: boolean) {
  if (current.role !== 'admin' || !current.is_active || !removesAccess) return
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE role='admin' AND is_active=true AND deleted_at IS NULL FOR UPDATE")
  if (rows.length <= 1) throw Response.json(
    { error: 'No se puede eliminar, desactivar ni cambiar el rol del último administrador activo' }, { status: 400 })
}
