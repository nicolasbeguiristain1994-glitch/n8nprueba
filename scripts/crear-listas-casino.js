/**
 * Crea (o actualiza) las listas de difusión pre-segmentadas de casino en la DB.
 *
 * Las listas quedan vacías hasta que se importen contactos con usernames que
 * coincidan con jugadores del casino — en ese momento se pueden repoblar con
 * el flag --repoblar.
 *
 * Uso:
 *   node scripts/crear-listas-casino.js "postgresql://..."
 *   node scripts/crear-listas-casino.js "postgresql://..." --repoblar
 *
 * Con --repoblar: actualiza los miembros de cada lista basándose en los
 *   contact_tags actuales (útil después de importar contactos nuevos).
 */

const { Pool } = require('/Users/nicobegui/Desktop/whatsapp-automation-platform/frontend/node_modules/pg');

const connectionString = process.argv[2]
if (!connectionString) {
  console.error('❌ Falta connection string. Uso: node scripts/crear-listas-casino.js "postgresql://..."')
  process.exit(1)
}
const REPOBLAR = process.argv.includes('--repoblar')

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, family: 4 })

// ── Definición de listas — single source of truth ────────────────────────────
// Loaded from the shared JSON file consumed by both this script and the app route.
// To add, remove, or change a list, edit only: frontend/lib/casino-lists.json
const LISTAS = require('../frontend/lib/casino-lists.json')

async function repoblarLista(client, listId, tags, customQuery) {
  // Borrar miembros actuales
  await client.query(`DELETE FROM contact_list_members WHERE list_id = $1`, [listId])

  let ids = []
  if (customQuery) {
    const { rows } = await client.query(customQuery)
    ids = rows.map(r => r.id)
  } else if (tags.length > 0) {
    const { rows } = await client.query(
      `SELECT c.id
       FROM contacts c
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS required_tag
         WHERE NOT EXISTS (
           SELECT 1 FROM contact_tags ct
           WHERE ct.contact_id = c.id AND ct.tag = required_tag
         )
       )`,
      [tags]
    )
    ids = rows.map(r => r.id)
  }

  if (ids.length > 0) {
    await client.query(
      `INSERT INTO contact_list_members (list_id, contact_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [listId, ids]
    )
  }
  return ids.length
}

async function main() {
  // Obtener o crear admin user id para owned_by
  const { rows: adminRows } = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`
  )
  const ownerId = adminRows[0]?.id || null

  console.log(`\n📋 ${REPOBLAR ? 'Creando/repoblando' : 'Creando'} ${LISTAS.length} listas de casino...\n`)

  let creadas = 0, actualizadas = 0

  for (const lista of LISTAS) {
    const filters = JSON.stringify({ casino_tags: lista.tags, custom: !!lista.custom_query })

    // Upsert de la lista por nombre
    const { rows } = await pool.query(
      `INSERT INTO contact_lists (name, description, filters, owned_by, updated_by)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             filters     = EXCLUDED.filters,
             updated_by  = EXCLUDED.updated_by
       RETURNING id, (xmax = 0) AS is_new`,
      [lista.nombre, lista.descripcion, filters, ownerId]
    )
    const { id: listId, is_new } = rows[0]

    let members = 0
    if (REPOBLAR) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        members = await repoblarLista(client, listId, lista.tags, lista.custom_query)
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    }

    const estado = is_new ? '✅ creada' : '🔄 actualizada'
    const info   = REPOBLAR ? ` → ${members} contactos` : ''
    console.log(`  ${estado}  ${lista.nombre}${info}`)
    if (is_new) creadas++; else actualizadas++
  }

  console.log(`\n══════════════════════════════════════════`)
  console.log(`✅ Listas creadas:      ${creadas}`)
  console.log(`🔄 Listas actualizadas: ${actualizadas}`)
  if (REPOBLAR) {
    console.log(`\nPara repoblar de nuevo después de importar contactos:`)
    console.log(`  node scripts/crear-listas-casino.js "postgresql://..." --repoblar`)
  } else {
    console.log(`\nLas listas están vacías hasta que importes contactos.`)
    console.log(`Después de importar, repoblalas con:`)
    console.log(`  node scripts/crear-listas-casino.js "postgresql://..." --repoblar`)
  }
  console.log(`══════════════════════════════════════════\n`)

  await pool.end()
}

main().catch(e => { console.error('❌', e.message); pool.end(); process.exit(1) })
