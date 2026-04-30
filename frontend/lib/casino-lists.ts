/**
 * Shared casino list definitions and repopulation logic.
 * Used by:
 *   - POST /api/lists/casino/repopulate  (in-app admin action)
 *   - scripts/crear-listas-casino.js     (CLI bootstrap — require('../frontend/lib/casino-lists.json'))
 *
 * SINGLE SOURCE OF TRUTH: list definitions live in casino-lists.json (same directory).
 * To add, remove, or change a list, edit only that JSON file.
 */

import { withTransaction } from '@/lib/db'
import type { PoolClient } from 'pg'
import rawLists from './casino-lists.json'

// ── List definitions ──────────────────────────────────────────────────────────

export type CasinoListDef = {
  nombre:        string
  descripcion:   string
  tags:          string[]
  custom_query?: string
}

export const CASINO_LISTS: CasinoListDef[] = rawLists as CasinoListDef[]

// ── Result type ───────────────────────────────────────────────────────────────

export type RepopulateResult = {
  lists: Array<{ nombre: string; members: number; created: boolean }>
  total_lists: number
  timestamp: string
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function repoblarLista(
  client: PoolClient,
  listId: string,
  tags: string[],
  customQuery?: string,
): Promise<number> {
  await client.query(`DELETE FROM contact_list_members WHERE list_id = $1`, [listId])

  let ids: string[] = []

  if (customQuery) {
    const { rows } = await client.query<{ id: string }>(customQuery)
    ids = rows.map(r => r.id)
  } else if (tags.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT c.id
       FROM contacts c
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS required_tag
         WHERE NOT EXISTS (
           SELECT 1 FROM contact_tags ct
           WHERE ct.contact_id = c.id AND ct.tag = required_tag
         )
       )`,
      [tags],
    )
    ids = rows.map(r => r.id)
  }

  if (ids.length > 0) {
    await client.query(
      `INSERT INTO contact_list_members (list_id, contact_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [listId, ids],
    )
  }

  return ids.length
}

/**
 * Upsert all predefined casino lists and repopulate their members.
 * Runs each list in its own transaction so a single failure does not
 * abort the entire batch.
 */
export async function repopularListasCasino(ownerId: string | null): Promise<RepopulateResult> {
  const results: RepopulateResult['lists'] = []

  for (const lista of CASINO_LISTS) {
    const filters = JSON.stringify({ casino_tags: lista.tags, custom: !!lista.custom_query })

    const listRow = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO contact_lists (name, description, filters, source, owned_by, updated_by)
         VALUES ($1, $2, $3, 'casino', $4, $4)
         ON CONFLICT (name) DO UPDATE
           SET description = EXCLUDED.description,
               filters     = EXCLUDED.filters,
               source      = 'casino',
               updated_by  = EXCLUDED.updated_by
         RETURNING id, (xmax = 0) AS is_new`,
        [lista.nombre, lista.descripcion, filters, ownerId],
      )
      const { id: listId, is_new: created } = rows[0]
      const members = await repoblarLista(client, listId, lista.tags, lista.custom_query)
      return { nombre: lista.nombre, members, created }
    })

    results.push(listRow)
  }

  return {
    lists:       results,
    total_lists: results.length,
    timestamp:   new Date().toISOString(),
  }
}
