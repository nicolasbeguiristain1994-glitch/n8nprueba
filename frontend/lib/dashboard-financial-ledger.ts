/** Original provider amounts supplement, never overwrite, the operational cash ledger.
 * Bonuses are separate operations and must not inflate cash deposits or their count.
 */
export function financialLedgerSql(filter?: (alias: string) => string): string {
  return `SELECT t.id::text AS id, t.id_rec, t.platform, t.agente, t.username,
    CASE WHEN t.tipo='carga' AND t.platform IN ('zeus','bet30')
      AND lower(trim(t.raw_detalles))='bono' THEN 'bono' ELSE t.tipo END AS tipo,
    COALESCE(s.monto,t.monto) AS monto, t.fecha, t.fecha_hora_utc, t.raw_detalles
    FROM casino_transactions t
    LEFT JOIN casino_financial_source_records s ON s.transaction_id=t.id AND s.platform=t.platform AND s.kind='importe_original'
    ${filter ? `WHERE ${filter('t')}` : ''}
    UNION ALL
    SELECT 'source:' || platform || ':' || source_id, NULL::bigint, platform, agente, username,
      'bono', monto, fecha, fecha_hora_utc, 'Bono'
    FROM casino_financial_source_records f WHERE kind='bono' ${filter ? `AND ${filter('f')}` : ''}`
}
