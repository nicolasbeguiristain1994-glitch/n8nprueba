import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// GET /api/settings/frequency-rules
// Solo lectura. Edición en versión futura (directamente en DB por ahora).
// Retorna reglas de contact_frequency_rules ordenadas por especificidad
// (global primero, luego más específicas).

type FrequencyRuleRow = {
  id: string
  operator_id: string | null
  operator_email: string | null
  seg_monto: string | null
  seg_actividad: string | null
  max_per_day: number
  max_per_week: number
  min_hours_between_sends: number
  is_active: boolean
  created_at: string
  specificity: number
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const rows = await query<FrequencyRuleRow>(
      `SELECT
         cfr.id,
         cfr.operator_id::text AS operator_id,
         u.email               AS operator_email,
         cfr.seg_monto,
         cfr.seg_actividad,
         cfr.max_per_day,
         cfr.max_per_week,
         cfr.min_hours_between_sends,
         cfr.is_active,
         cfr.created_at::text AS created_at,
         (
           CASE WHEN cfr.operator_id   IS NOT NULL THEN 4 ELSE 0 END +
           CASE WHEN cfr.seg_monto     IS NOT NULL THEN 2 ELSE 0 END +
           CASE WHEN cfr.seg_actividad IS NOT NULL THEN 1 ELSE 0 END
         ) AS specificity
       FROM contact_frequency_rules cfr
       LEFT JOIN users u ON u.id = cfr.operator_id
       WHERE cfr.is_active = true
       ORDER BY specificity ASC, cfr.created_at ASC`,
    )

    return NextResponse.json({ rules: rows })
  } catch (e) {
    console.error('[/api/settings/frequency-rules GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
