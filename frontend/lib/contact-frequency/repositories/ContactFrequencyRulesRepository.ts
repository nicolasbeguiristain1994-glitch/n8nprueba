/**
 * ContactFrequencyRulesRepository.ts — ContactFrequencyEngine
 *
 * Acceso a la tabla contact_frequency_rules.
 *
 * Path crítico (evaluate): findActiveRulesForContext() — solo lectura.
 * Path administrativo (API): upsert() — escritura con idempotencia.
 *
 * Convención de tipos DB:
 *   pg retorna columnas SMALLINT/INTEGER/BIGINT como strings cuando el pool no
 *   tiene typeParser configurado. Se convierten explícitamente con Number().
 */

import { query } from '@/lib/db'
import type { PoolClient } from 'pg'
import type { ContactFrequencyRule, SegMonto, SegActividad } from '../types'

// ── Tipo de fila DB ───────────────────────────────────────────────────────────

/** Representa una fila cruda de contact_frequency_rules. */
interface RuleRow {
  id:                       string
  operator_id:              string | null
  seg_monto:                string | null
  seg_actividad:            string | null
  max_per_day:              string   // pg retorna smallint como string
  max_per_week:             string
  min_hours_between_sends:  string
  is_active:                boolean
  created_at:               string
  updated_at:               string
}

// ── Mapeo DB → dominio ────────────────────────────────────────────────────────

function rowToRule(row: RuleRow): ContactFrequencyRule {
  return {
    id:                      row.id,
    operator_id:             row.operator_id,
    seg_monto:               row.seg_monto     as SegMonto | null,
    seg_actividad:           row.seg_actividad as SegActividad | null,
    max_per_day:             Number(row.max_per_day),
    max_per_week:            Number(row.max_per_week),
    min_hours_between_sends: Number(row.min_hours_between_sends),
    is_active:               row.is_active,
    created_at:              new Date(row.created_at),
    updated_at:              new Date(row.updated_at),
  }
}

// ── Repositorio ───────────────────────────────────────────────────────────────

export class ContactFrequencyRulesRepository {

  /**
   * Carga todas las reglas activas relevantes para el contexto dado.
   *
   * Estrategia de carga: trae todas las reglas del operador específico MÁS
   * todas las reglas globales (operator_id IS NULL). Las reglas de otros
   * operadores nunca aplican a este contexto, por lo que no se cargan.
   *
   * El ordenamiento en SQL es cosmético — la resolución real de especificidad
   * ocurre en resolveApplicableRule() (rules.ts), que es la fuente de verdad.
   *
   * Rendimiento: O(1) queries, ~1-5ms con índice idx_contact_frequency_rules_operator.
   * Resultado típico: 1–10 filas (pocas reglas en producción).
   *
   * @param operatorId - UUID del operador. NULL: carga solo reglas globales.
   */
  async findActiveRulesForContext(
    operatorId: string | null,
    client?: PoolClient,
  ): Promise<ContactFrequencyRule[]> {
    const sql = `
      SELECT
        id,
        operator_id,
        seg_monto,
        seg_actividad,
        max_per_day,
        max_per_week,
        min_hours_between_sends,
        is_active,
        created_at,
        updated_at
      FROM contact_frequency_rules
      WHERE is_active = true
        AND (operator_id = $1 OR operator_id IS NULL)
      ORDER BY
        (
          CASE WHEN operator_id   IS NOT NULL THEN 4 ELSE 0 END +
          CASE WHEN seg_monto     IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN seg_actividad IS NOT NULL THEN 1 ELSE 0 END
        ) DESC,
        created_at DESC
    `
    const rows = client
      ? (await client.query<RuleRow>(sql, [operatorId])).rows
      : await query<RuleRow>(sql, [operatorId])

    return rows.map(rowToRule)
  }

  /**
   * Inserta una regla nueva o actualiza la existente para el mismo scope.
   *
   * "Mismo scope" = misma combinación de (operator_id, seg_monto, seg_actividad),
   * representada por la columna generada `scope_key` de la migración 050.
   *
   * Idempotente: llamar dos veces con los mismos datos produce el mismo resultado.
   * El campo updated_at se actualiza en cada DO UPDATE.
   *
   * @param input     - Datos de la regla a crear/actualizar
   * @param createdBy - UUID del usuario que realiza el cambio (para auditoría)
   */
  async upsert(
    input: Omit<ContactFrequencyRule, 'id' | 'created_at' | 'updated_at'>,
    createdBy: string | null,
  ): Promise<ContactFrequencyRule> {
    const rows = await query<RuleRow>(`
      INSERT INTO contact_frequency_rules
        (operator_id, seg_monto, seg_actividad,
         max_per_day, max_per_week, min_hours_between_sends,
         is_active, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (scope_key)
      DO UPDATE SET
        max_per_day              = EXCLUDED.max_per_day,
        max_per_week             = EXCLUDED.max_per_week,
        min_hours_between_sends  = EXCLUDED.min_hours_between_sends,
        is_active                = EXCLUDED.is_active,
        updated_at               = NOW()
      RETURNING
        id, operator_id, seg_monto, seg_actividad,
        max_per_day, max_per_week, min_hours_between_sends,
        is_active, created_at, updated_at
    `, [
      input.operator_id,
      input.seg_monto,
      input.seg_actividad,
      input.max_per_day,
      input.max_per_week,
      input.min_hours_between_sends,
      input.is_active,
      createdBy,
    ])

    return rowToRule(rows[0])
  }

  /**
   * Desactiva (soft-delete) una regla por ID.
   * La regla permanece en DB para auditoría pero no es cargada por findActiveRulesForContext().
   *
   * @param ruleId   - UUID de la regla a desactivar
   * @param removedBy - UUID del usuario que realiza la acción
   */
  async deactivate(ruleId: string, removedBy: string | null): Promise<void> {
    await query(`
      UPDATE contact_frequency_rules
      SET is_active  = false,
          removed_by = $2,
          updated_at = NOW()
      WHERE id = $1
    `, [ruleId, removedBy])

    console.log(`[freq-rules-repo] deactivated rule=${ruleId} by=${removedBy ?? 'system'}`)
  }

  /**
   * Lista todas las reglas (activas e inactivas) para el panel de administración.
   * No usar en el path de evaluación.
   */
  async findAll(): Promise<ContactFrequencyRule[]> {
    const rows = await query<RuleRow>(`
      SELECT
        id, operator_id, seg_monto, seg_actividad,
        max_per_day, max_per_week, min_hours_between_sends,
        is_active, created_at, updated_at
      FROM contact_frequency_rules
      ORDER BY
        is_active DESC,
        (
          CASE WHEN operator_id   IS NOT NULL THEN 4 ELSE 0 END +
          CASE WHEN seg_monto     IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN seg_actividad IS NOT NULL THEN 1 ELSE 0 END
        ) DESC,
        created_at DESC
    `)

    return rows.map(rowToRule)
  }
}
