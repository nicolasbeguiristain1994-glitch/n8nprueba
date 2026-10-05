/** Shared SQL for listing, counting, exporting and resolving saved audiences. */
export function segmentationSQL(alias = 'contacts') {
  const p = `${alias}.segmentation_profile`
  const today = `(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`
  const automatic = `casino_monthly_value_tier((${p}->>'monthly_average')::numeric)`
  const segment = `(CASE WHEN ${alias}.segment_is_manual THEN ${alias}.segment::text WHEN ${p} IS NOT NULL THEN ${automatic} ELSE ${alias}.segment::text END)`
  const activity = `casino_deposit_activity((${p}->>'first_date')::date,(${p}->>'last_date')::date,(${p}->>'deposits')::integer,${today})`
  const tenure = `casino_contact_tenure((${p}->>'first_date')::date,${today})`
  const quality = `(CASE WHEN ${p} IS NULL THEN 'sin_datos' WHEN (${p}->>'deposits')::int=0 THEN 'sin_depositos' WHEN (${p}->>'estimated')::boolean THEN 'estimado' WHEN (${p}->>'partial_history')::boolean THEN 'parcial' ELSE 'observado' END)`
  return { segment, automatic, activity, tenure, quality }
}

export interface SegmentationProfile {
  monthly_average: number | null; amount: number | null; deposits: number; withdrawals: number
  first_date: string | null; last_date: string | null; active_months: number
  estimated: boolean; partial_history: boolean; calculated_at: string; as_of: string
  amount_30d: number | null; amount_90d: number | null; deposits_30d: number | null; deposits_90d: number | null
  accounts: { platform: string | null; username: string; last_sync_at: string | null }[]
}
export const QUALITY_LABELS: Record<string, string> = {
  sin_datos: 'Sin historial vinculado', sin_depositos: 'Sin depósitos registrados',
  estimado: 'Historial estimado', parcial: 'Historial parcial', observado: 'Movimientos registrados',
}
