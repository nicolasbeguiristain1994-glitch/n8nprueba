/**
 * Shared casino list definitions and repopulation logic.
 * Used by:
 *   - POST /api/lists/casino/repopulate  (in-app admin action)
 *
 * NOTE: scripts/crear-listas-casino.js is a standalone Node.js script that
 * still carries its own copy of the list definitions (CJS require, no ESM import).
 * If you add or change a list here, mirror the change in that script too.
 */

import { withTransaction } from '@/lib/db'
import type { PoolClient } from 'pg'

// ── List definitions ──────────────────────────────────────────────────────────

export type CasinoListDef = {
  nombre:       string
  descripcion:  string
  tags:         string[]
  custom_query?: string
}

export const CASINO_LISTS: CasinoListDef[] = [
  // Reactivación VIP (máxima prioridad)
  {
    nombre:      '🎰 VIP Inactivos',
    descripcion: 'Jugadores VIP sin actividad en más de 60 días. Máxima prioridad de reactivación.',
    tags:        ['casino:monto:vip', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '⚠️ VIP en Riesgo',
    descripcion: 'Jugadores VIP sin actividad entre 30 y 60 días.',
    tags:        ['casino:monto:vip', 'casino:actividad:en_riesgo'],
  },
  // Reactivación Alto
  {
    nombre:      '🎯 Alto Inactivos',
    descripcion: 'Jugadores de monto alto sin actividad en más de 60 días.',
    tags:        ['casino:monto:alto', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '📉 Alto en Riesgo',
    descripcion: 'Jugadores de monto alto sin actividad entre 30 y 60 días.',
    tags:        ['casino:monto:alto', 'casino:actividad:en_riesgo'],
  },
  // Fidelización activos
  {
    nombre:      '⭐ VIP Frecuentes',
    descripcion: 'Jugadores VIP que juegan 3+ veces por semana.',
    tags:        ['casino:monto:vip', 'casino:actividad:frecuente'],
  },
  {
    nombre:      '🏆 VIP Regulares',
    descripcion: 'Jugadores VIP que juegan 1-3 veces por semana.',
    tags:        ['casino:monto:vip', 'casino:actividad:regular'],
  },
  // Nuevos
  {
    nombre:      '🆕 Nuevos (todos)',
    descripcion: 'Jugadores que ingresaron en los últimos 30 días.',
    tags:        ['casino:actividad:nuevo'],
  },
  {
    nombre:      '🆕 Nuevos VIP',
    descripcion: 'Nuevos jugadores con monto VIP desde el primer mes.',
    tags:        ['casino:monto:vip', 'casino:actividad:nuevo'],
  },
  // Por agente
  {
    nombre:      '🏢 Betcoin — Inactivos',
    descripcion: 'Jugadores de betcoin inactivos hace más de 60 días.',
    tags:        ['casino:agente:betcoin', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '🏢 Bigwin — Inactivos',
    descripcion: 'Jugadores de bigwin inactivos hace más de 60 días.',
    tags:        ['casino:agente:bigwin', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '🏢 Farabet — Inactivos',
    descripcion: 'Jugadores de farabet inactivos hace más de 60 días.',
    tags:        ['casino:agente:farabet', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '🏢 Ofizeus — Inactivos',
    descripcion: 'Jugadores de ofizeus inactivos hace más de 60 días.',
    tags:        ['casino:agente:ofizeus', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '🏢 Royal — Inactivos',
    descripcion: 'Jugadores de royal inactivos hace más de 60 días.',
    tags:        ['casino:agente:royal', 'casino:actividad:inactivo'],
  },
  // Medio activos (base amplia)
  {
    nombre:      '📊 Medio Inactivos',
    descripcion: 'Jugadores de monto medio inactivos. Buena base para campañas de volumen.',
    tags:        ['casino:monto:medio', 'casino:actividad:inactivo'],
  },
  {
    nombre:      '📊 Todos los Activos VIP+Alto',
    descripcion: 'Jugadores VIP o Alto que jugaron en los últimos 30 días (frecuentes + regulares + ocasionales).',
    tags:        [],
    custom_query: `
      SELECT DISTINCT c.id
      FROM contacts c
      JOIN contact_tags ct_monto     ON ct_monto.contact_id     = c.id AND ct_monto.tag     IN ('casino:monto:vip', 'casino:monto:alto')
      JOIN contact_tags ct_actividad ON ct_actividad.contact_id = c.id AND ct_actividad.tag IN ('casino:actividad:frecuente','casino:actividad:regular','casino:actividad:ocasional','casino:actividad:nuevo')
    `,
  },
  // Valor en Riesgo
  {
    nombre:      '🚨 Críticos — VIP',
    descripcion: 'Jugadores VIP inactivos o en riesgo. Máxima prioridad de recuperación.',
    tags:        ['casino:valor_riesgo:critico', 'casino:monto:vip'],
  },
  {
    nombre:      '🚨 Críticos — Alto',
    descripcion: 'Jugadores de monto alto inactivos o en riesgo.',
    tags:        ['casino:valor_riesgo:critico', 'casino:monto:alto'],
  },
  // Antigüedad
  {
    nombre:      '🕰️ Veteranos Inactivos',
    descripcion: 'Clientes con más de 1 año de historial que dejaron de jugar. Alta probabilidad de reactivación con oferta personalizada.',
    tags:        [],
    custom_query: `
      SELECT DISTINCT c.id
      FROM contacts c
      JOIN contact_tags ct_ant ON ct_ant.contact_id = c.id AND ct_ant.tag IN ('casino:antiguedad:veterano','casino:antiguedad:leal')
      JOIN contact_tags ct_act ON ct_act.contact_id = c.id AND ct_act.tag = 'casino:actividad:inactivo'
    `,
  },
  {
    nombre:      '✨ Nuevos VIP / Alto',
    descripcion: 'Jugadores nuevos o recientes (menos de 90 días) con monto VIP o alto. Onboarding de alto valor.',
    tags:        [],
    custom_query: `
      SELECT DISTINCT c.id
      FROM contacts c
      JOIN contact_tags ct_ant   ON ct_ant.contact_id   = c.id AND ct_ant.tag   IN ('casino:antiguedad:nuevo','casino:antiguedad:reciente')
      JOIN contact_tags ct_monto ON ct_monto.contact_id = c.id AND ct_monto.tag IN ('casino:monto:vip','casino:monto:alto')
    `,
  },
]

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
        `INSERT INTO contact_lists (name, description, filters, owned_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (name) DO UPDATE
           SET description = EXCLUDED.description,
               filters     = EXCLUDED.filters,
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
