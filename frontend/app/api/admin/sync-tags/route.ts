import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

/**
 * POST /api/admin/sync-tags
 *
 * Sincroniza contact_tags de casino (actividad, antiguedad, valor_riesgo)
 * directamente desde casino_players. Reemplaza los tags stale sin depender
 * del script de segmentación en background.
 *
 * Solo admin.
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const { getSessionFromRequest } = await import('@/lib/auth')
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const results: { step: string; ok: boolean; rows?: number; error?: string }[] = []

  async function run(step: string, sql: string, params: unknown[] = []) {
    try {
      const res = await query(sql, params)
      const rows = Array.isArray(res) ? res.length : (res as { rowCount?: number }).rowCount ?? 0
      results.push({ step, ok: true, rows })
    } catch (e) {
      results.push({ step, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Paso 1: Sync contacts.segment desde casino_players
  await run('sync segment', `
    UPDATE contacts c
    SET segment = cp.seg_monto::contact_segment, updated_at = NOW()
    FROM casino_players cp
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
      AND cp.seg_monto IS NOT NULL
      AND c.segment::text IS DISTINCT FROM cp.seg_monto
  `)

  // Paso 2: Sync last_deposit_at y contadores
  await run('sync deposits', `
    UPDATE contacts c
    SET
      total_deposits    = cp.cant_cargas,
      total_withdrawals = cp.cant_retiros,
      last_deposit_at   = cp.fecha_ultima::timestamptz,
      updated_at        = NOW()
    FROM casino_players cp
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
      AND cp.fecha_ultima IS NOT NULL
      AND (
        c.total_deposits    IS DISTINCT FROM cp.cant_cargas
        OR c.total_withdrawals IS DISTINCT FROM cp.cant_retiros
        OR c.last_deposit_at::date IS DISTINCT FROM cp.fecha_ultima
      )
  `)

  // Paso 3: DELETE + INSERT de tags en una sola query atómica por contacto.
  // Usa MERGE-style: borra exactamente los tags de casino:actividad/antiguedad/valor_riesgo
  // que no coincidan con el valor actual de casino_players, luego inserta los correctos.
  await run('delete stale tags', `
    DELETE FROM contact_tags ct
    WHERE (ct.tag LIKE 'casino:actividad:%'
        OR ct.tag LIKE 'casino:antiguedad:%'
        OR ct.tag LIKE 'casino:valor_riesgo:%')
      AND ct.contact_id IN (
        SELECT c.id
        FROM contacts c
        JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
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
    JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
    WHERE cp.seg_actividad IS NOT NULL AND cp.seg_monto IS NOT NULL
    ON CONFLICT (contact_id, tag) DO NOTHING
  `)

  const failed = results.filter(r => !r.ok)
  return NextResponse.json({
    ok:      failed.length === 0,
    results,
    message: failed.length === 0
      ? 'Tags sincronizados correctamente'
      : `${failed.length} pasos fallaron`,
  })
}
