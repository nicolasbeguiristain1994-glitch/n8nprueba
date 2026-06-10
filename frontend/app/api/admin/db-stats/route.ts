import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

/**
 * GET /api/admin/db-stats
 * Estadísticas rápidas de casino_transactions, casino_players y contacts.
 */
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const [txStats, playerStats, contactStats, tagStats] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE tipo = 'carga')                      AS total_cargas,
        COUNT(*) FILTER (WHERE tipo = 'retiro')                     AS total_retiros,
        MIN(fecha)  FILTER (WHERE tipo = 'carga')                   AS primera_carga,
        MAX(fecha)  FILTER (WHERE tipo = 'carga')                   AS ultima_carga,
        MAX(fecha)  FILTER (WHERE tipo = 'retiro')                  AS ultimo_retiro,
        COUNT(DISTINCT LOWER(username)) FILTER (WHERE tipo='carga') AS usuarios_unicos
      FROM casino_transactions
    `),
    query(`
      SELECT
        COUNT(*)                                           AS total_players,
        COUNT(*) FILTER (WHERE seg_actividad IS NOT NULL) AS con_actividad,
        COUNT(*) FILTER (WHERE seg_monto     IS NOT NULL) AS con_segmento,
        MAX(updated_at)                                   AS ultima_actualizacion
      FROM casino_players
    `),
    query(`
      SELECT
        COUNT(*)                                                AS total_contacts,
        COUNT(*) FILTER (WHERE segment IS NOT NULL)            AS con_segmento,
        COUNT(*) FILTER (WHERE last_deposit_at IS NOT NULL)    AS con_ultimo_deposito,
        MAX(last_deposit_at)                                   AS ultimo_deposito_en_contacts,
        COUNT(*) FILTER (WHERE platforms @> ARRAY['zeus'])     AS plataforma_zeus,
        COUNT(*) FILTER (WHERE platforms @> ARRAY['bet30'])    AS plataforma_bet30,
        COUNT(*) FILTER (WHERE platforms = '{}' OR platforms IS NULL) AS sin_plataforma
      FROM contacts
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE tag LIKE 'casino:actividad:%')  AS tags_actividad,
        COUNT(*) FILTER (WHERE tag LIKE 'casino:antiguedad:%') AS tags_antiguedad,
        COUNT(*) FILTER (WHERE tag LIKE 'casino:valor_riesgo:%') AS tags_valor_riesgo
      FROM contact_tags
    `),
  ])

  return NextResponse.json({
    casino_transactions: txStats[0],
    casino_players:      playerStats[0],
    contacts:            contactStats[0],
    contact_tags:        tagStats[0],
  })
}
