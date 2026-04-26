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

// ── Definición de listas ──────────────────────────────────────────────────────
const LISTAS = [
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
      JOIN contact_tags ct_monto    ON ct_monto.contact_id    = c.id AND ct_monto.tag    IN ('casino:monto:vip', 'casino:monto:alto')
      JOIN contact_tags ct_actividad ON ct_actividad.contact_id = c.id AND ct_actividad.tag IN ('casino:actividad:frecuente','casino:actividad:regular','casino:actividad:ocasional','casino:actividad:nuevo')
    `,
  },

  // ── Valor en Riesgo ─────────────────────────────────────────────────────────
  // Derived from (seg_monto + seg_actividad in_riesgo|inactivo) at import time.
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

  // ── Antigüedad ──────────────────────────────────────────────────────────────
  // Derived from fecha_primera in casino_players at import time.
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
