import { broadcastAccountKey, getLastContactBroadcasts } from './contact-broadcast-history'
import { contactLastMovementQuery, type ContactMovementRow } from './contact-last-movement'
import { configureBulkMovementRead, withContactMovementRead } from './contact-movement-read'
import { contactRead } from './contact-read'

export interface ContactHistory {
  id: string
  last_broadcast_at: string | null
  days_since_last_broadcast: number | null
  last_movement_date?: string | null
  days_since_last_movement?: number | null
}

/** Call only with contacts already authorized by the caller. */
export async function readContactHistory(
  rows: { id: string; phone_number: string; panel?: unknown }[],
  movementHistory?: Map<string, ContactMovementRow>,
  includeMovement = true,
): Promise<ContactHistory[]> {
  if (!rows.length) return []
  const movements = async () => {
    if (!includeMovement) return new Map<string, ContactMovementRow>()
    if (movementHistory) return movementHistory
    const bulk = rows.length > 500
    const lookup = contactLastMovementQuery({ sql: 'contacts.id = ANY($1::uuid[])', params: [rows.map(row => row.id)] }, undefined, bulk)
    const history = bulk ? await withContactMovementRead(async client => {
      await configureBulkMovementRead(client)
      return (await client.query<ContactMovementRow>(lookup.sql, lookup.params)).rows
    }) : await contactRead<ContactMovementRow>(lookup.sql, lookup.params)
    return new Map(history.map(row => [row.contact_id, row]))
  }
  const [broadcasts, history] = await Promise.all([
    getLastContactBroadcasts(rows, contactRead), movements(),
  ])
  return rows.map(row => {
    const broadcast = broadcasts.get(broadcastAccountKey(row.phone_number, row.panel))
    const movement = history.get(row.id)
    return {
      id: row.id,
      last_broadcast_at: broadcast?.lastBroadcastAt ?? null,
      days_since_last_broadcast: broadcast?.daysSinceLastBroadcast ?? null,
      ...(includeMovement ? {
        last_movement_date: movement?.last_movement ?? null,
        days_since_last_movement: movement?.days_inactive ?? null,
      } : {}),
    }
  })
}
