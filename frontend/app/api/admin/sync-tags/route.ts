import { NextRequest, NextResponse } from 'next/server'
import { getLongRunningClient } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

// Estrategia: primero eliminar TODOS los grupos (xxx) del nombre completo,
// luego tokenizar por / espacio y tab.
// Ej: "(carga mucho)Maximo3214z/Maximo3214b G.Sorteo"
//   → strip: "Maximo3214z/Maximo3214b G.Sorteo"
//   → tokens: ["maximo3214z", "maximo3214b", "g.sorteo"]
const USERNAME_MATCH = `cp.username_lower = ANY(
  SELECT LOWER(TRIM(tok))
  FROM regexp_split_to_table(
    REGEXP_REPLACE(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''), '\\([^)]*\\)\\s*', '', 'gi'),
    '[/ \\t]+'
  ) AS tok
  WHERE LENGTH(TRIM(tok)) > 1
)`

async function runSyncTags() {
  const client = await getLongRunningClient()
  const results: { step: string; ok: boolean; rows?: number; error?: string }[] = []

  async function run(step: string, sql: string) {
    try {
      const res = await client.query(sql)
      results.push({ step, ok: true, rows: res.rowCount ?? 0 })
    } catch (e) {
      results.push({ step, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  try {
    await run('sync segment', `
      UPDATE contacts c
      SET segment = cp.seg_monto::contact_segment, updated_at = NOW()
      FROM casino_players cp
      WHERE ${USERNAME_MATCH}
        AND cp.seg_monto IS NOT NULL
        AND c.segment::text IS DISTINCT FROM cp.seg_monto
    `)

    await run('sync deposits', `
      UPDATE contacts c
      SET
        total_deposits    = COALESCE(am.cant_cargas, 0),
        total_withdrawals = cp.cant_retiros,
        last_deposit_at   = am.last_tx_date,
        updated_at        = NOW()
      FROM casino_players cp
      LEFT JOIN (
        SELECT
          LOWER(username)         AS username_lower,
          COUNT(*)                AS cant_cargas,
          MAX(fecha)::timestamptz AS last_tx_date
        FROM casino_transactions
        WHERE tipo = 'carga'
        GROUP BY LOWER(username)
      ) am ON am.username_lower = cp.username_lower
      WHERE ${USERNAME_MATCH}
        AND (
          c.total_deposits  IS DISTINCT FROM COALESCE(am.cant_cargas, 0)
          OR c.last_deposit_at IS DISTINCT FROM am.last_tx_date
        )
    `)

    await run('delete stale tags', `
      DELETE FROM contact_tags ct
      WHERE (ct.tag LIKE 'casino:actividad:%'
          OR ct.tag LIKE 'casino:antiguedad:%'
          OR ct.tag LIKE 'casino:valor_riesgo:%')
        AND ct.contact_id IN (
          SELECT c.id
          FROM contacts c
          JOIN casino_players cp ON ${USERNAME_MATCH}
          WHERE cp.seg_actividad IS NOT NULL
        )
    `)

    await run('insert fresh tags', `
      INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
      SELECT
        gen_random_uuid(), c.id,
        unnest(array_remove(ARRAY[
          'casino:actividad:' || cp.seg_actividad,
          CASE
            WHEN cp.fecha_primera IS NULL                             THEN NULL
            WHEN (CURRENT_DATE - cp.fecha_primera) <  30             THEN 'casino:antiguedad:nuevo'
            WHEN (CURRENT_DATE - cp.fecha_primera) <  90             THEN 'casino:antiguedad:reciente'
            WHEN (CURRENT_DATE - cp.fecha_primera) < 150             THEN 'casino:antiguedad:establecido'
            WHEN (CURRENT_DATE - cp.fecha_primera) < 270             THEN 'casino:antiguedad:veterano'
            ELSE                                                           'casino:antiguedad:leal'
          END,
          CASE
            WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
              AND cp.seg_monto IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
            WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
              AND cp.seg_monto = 'medio'                                     THEN 'casino:valor_riesgo:medio'
            WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
              AND cp.seg_monto = 'bajo'                                      THEN 'casino:valor_riesgo:bajo'
            ELSE NULL
          END
        ], NULL)),
        'sync_tags', NOW()
      FROM contacts c
      JOIN casino_players cp ON ${USERNAME_MATCH}
      WHERE cp.seg_actividad IS NOT NULL AND cp.seg_monto IS NOT NULL
      ON CONFLICT (contact_id, tag) DO NOTHING
    `)
  } finally {
    await client.end()
  }

  const failed = results.filter(r => !r.ok)
  console.log('[sync-tags background]', failed.length === 0 ? 'OK' : `${failed.length} pasos fallaron`, results)
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const { getSessionFromRequest } = await import('@/lib/auth')
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Corre en background para evitar timeout HTTP de Railway (~60s)
  void runSyncTags()

  return NextResponse.json({
    ok:      true,
    message: 'Sync de tags iniciado en background (~3-5 minutos). Revisá los logs de Railway para el resultado.',
  })
}
