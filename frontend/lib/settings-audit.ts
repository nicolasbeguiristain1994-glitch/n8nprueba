import { query } from '@/lib/db'

interface AuditLogParams {
  table: string
  recordId: string
  operation: 'INSERT' | 'UPDATE'
  oldValue: unknown
  newValue: unknown
  changedBy: string
  reason?: string
  workspaceId?: string
}

/**
 * Registra manualmente un cambio en settings_audit_log.
 *
 * Fire-and-forget en la práctica: no bloquea el flujo principal si falla.
 * Loguea error en caso de fallo para visibilidad operativa.
 *
 * NOTA: el trigger SECURITY DEFINER en DB ya captura automáticamente todos
 * los cambios vía SQL (INSERT/UPDATE en segmentation_tiers y scoring_config).
 * Este servicio es para cambios realizados directamente desde TypeScript que
 * no pasan por las tablas DB (hoy ninguno — infraestructura para uso futuro).
 */
export async function log(params: AuditLogParams): Promise<void> {
  const {
    table,
    recordId,
    operation,
    oldValue,
    newValue,
    changedBy,
    reason,
    workspaceId = 'default',
  } = params

  try {
    await query(
      `INSERT INTO settings_audit_log
         (table_name, record_id, operation, old_value, new_value, changed_by, reason, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        table,
        recordId,
        operation,
        oldValue !== null && oldValue !== undefined ? JSON.stringify(oldValue) : null,
        JSON.stringify(newValue),
        changedBy,
        reason ?? null,
        workspaceId,
      ],
    )
  } catch (err) {
    console.error('[settings-audit] Fallo al escribir entrada de audit log:', {
      table,
      recordId,
      operation,
      changedBy,
      err,
    })
    // No relanzar: fire-and-forget, no bloquear el flujo principal
  }
}
