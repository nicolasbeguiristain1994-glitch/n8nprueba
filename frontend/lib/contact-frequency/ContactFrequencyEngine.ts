/**
 * ContactFrequencyEngine.ts
 *
 * Motor principal de control de frecuencia de envíos por contacto.
 *
 * ## Responsabilidad
 * Dado un contacto y su contexto operacional, decide si el sistema puede enviar
 * un mensaje ahora (ALLOW), debería esperar (DELAY), o debe bloquearse (BLOCK).
 *
 * ## Métodos disponibles
 *
 * ### evaluate() — lectura pura, sin atomicidad
 *   Para casos donde el registro se hace por separado.
 *   ⚠️  Susceptible a race condition TOCTOU en entornos multi-línea.
 *   Usar solo cuando la atomicidad no sea crítica (monolínea, tests, admin).
 *
 * ### atomicEvaluateAndRecord() — evaluación + registro atómicos (recomendado)
 *   Resuelve la race condition TOCTOU usando un Advisory Lock de PostgreSQL.
 *   Ver sección "Race Condition" más abajo.
 *
 * ### recordSend() — registro post-envío (fallback)
 *   Solo para casos donde se usó evaluate() sin atomicidad.
 *
 * ## Race Condition TOCTOU y su solución
 *
 * Problema:
 *   Escenario con 30 líneas enviando campañas en paralelo:
 *   1. Línea A llama evaluate(contactX) → lee count=0 → ALLOW
 *   2. Línea B llama evaluate(contactX) → lee count=0 → ALLOW  (race!)
 *   3. Línea A envía y llama recordSend() → count=1
 *   4. Línea B envía y llama recordSend() → count=2  ← viola max_per_day=1
 *
 * Solución (atomicEvaluateAndRecord):
 *   1. Abre transacción → adquiere pg_advisory_xact_lock(namespace, hash(contactId))
 *      El lock BLOQUEA a cualquier otra llamada para el mismo contacto.
 *   2. Lee el perfil actual (seguro: nadie más puede escribir mientras tenemos el lock).
 *   3. Calcula decisión.
 *   4. Si ALLOW/DELAY: inserta el registro en contact_send_history, DENTRO
 *      de la misma transacción. El slot queda reservado.
 *   5. COMMIT → libera el lock.
 *   6. Línea B puede ahora adquirir el lock → lee count=1 → BLOCK. ✓
 *
 *   El lock se mantiene solo mientras duren las operaciones de DB (< 50ms).
 *   La llamada a Evolution API ocurre DESPUÉS del COMMIT, fuera del lock.
 *
 *   Comportamiento en fallos post-COMMIT:
 *   Si Evolution API falla después de que el registro fue insertado, el registro
 *   permanece. Esto es INTENCIONAL: un intento fallido cuenta como "slot usado",
 *   lo que es conservador y protector para anti-spam.
 *
 * ## Arquitectura interna
 *  ContactFrequencyEngine (este archivo)
 *    → withTransaction + pg_advisory_xact_lock    (race condition fix)
 *    → ContactFrequencyRulesRepository            (lee contact_frequency_rules)
 *    → ContactSendHistoryRepository               (lee/escribe contact_send_history)
 *    → resolveApplicableRule()                    (rules.ts — lógica de resolución)
 *    → calculateRiskScore()                       (risk-scorer.ts — scoring y decisión)
 */

import { withTransaction }                      from '@/lib/db'
import { ContactFrequencyRulesRepository }      from './repositories/ContactFrequencyRulesRepository'
import { ContactSendHistoryRepository }         from './repositories/ContactSendHistoryRepository'
import { resolveApplicableRule }                from './rules'
import { calculateRiskScore }                   from './risk-scorer'
import type {
  FrequencyEvaluationInput,
  FrequencyEvaluationResult,
  RecordSendInput,
} from './types'

// ── Constantes ────────────────────────────────────────────────────────────────

/**
 * Namespace del advisory lock (primer argumento de pg_advisory_xact_lock).
 * Número arbitrario único para este módulo — evita colisiones con otros módulos
 * que también usen advisory locks.
 * Valor = número de la migración que creó las tablas (050).
 */
const ADVISORY_LOCK_NAMESPACE = 50

// ── Singletons de repositorios ────────────────────────────────────────────────
//
// Instancias creadas una vez al cargar el módulo.
// Sin estado mutable → seguro para uso concurrente en el procesador multi-línea.

const rulesRepo   = new ContactFrequencyRulesRepository()
const historyRepo = new ContactSendHistoryRepository()

// ── Motor ─────────────────────────────────────────────────────────────────────

export class ContactFrequencyEngine {

  /**
   * Evalúa si es seguro enviar un mensaje al contacto ahora.
   *
   * Lectura pura: no escribe en DB, no tiene mecanismo de atomicidad.
   * ⚠️  En entornos multi-línea usar atomicEvaluateAndRecord() para evitar
   *     la race condition TOCTOU (ver documentación del módulo).
   *
   * Útil para: monolínea, previsualizaciones en UI, tests, métricas.
   *
   * @param input - Contexto de evaluación
   */
  static async evaluate(input: FrequencyEvaluationInput): Promise<FrequencyEvaluationResult> {
    const { contactId, operatorId, campaignId, segMonto, segActividad } = input
    const evaluatedAt = new Date()

    const profile        = await historyRepo.getFrequencyProfile(contactId)
    const rules          = await rulesRepo.findActiveRulesForContext(operatorId)
    const applicableRule = resolveApplicableRule(rules, operatorId, segMonto, segActividad)
    const { decision, riskScore, reason } = calculateRiskScore(profile, applicableRule)

    ContactFrequencyEngine.logDecision(decision, riskScore, reason, contactId, campaignId, operatorId, applicableRule.id)

    return { decision, riskScore, reason, profile, applicableRule, evaluatedAt }
  }

  /**
   * Evalúa Y registra el envío en una sola operación atómica.
   *
   * ## Garantías
   * ─ Libre de race condition TOCTOU: el advisory lock serializa evaluaciones
   *   concurrentes del mismo contacto.
   * ─ Idempotente: si campaignRecipientId ya existe → DO NOTHING (no duplica).
   * ─ El registro ocurre DENTRO de la transacción que mantiene el lock.
   *   Cuando el lock se libera (COMMIT), el slot ya está reservado.
   *
   * ## Uso recomendado en sendOneUnit()
   *
   *   // Reemplaza la combinación evaluate() + recordSend():
   *   const freqResult = await ContactFrequencyEngine.atomicEvaluateAndRecord(
   *     { contactId: unit.contact_id, operatorId: campaign.owned_by, campaignId },
   *     { contactId: unit.contact_id, campaignId, operatorId: campaign.owned_by,
   *       phoneNumber: unit.phone_number, campaignRecipientId: unit.id },
   *   )
   *   if (freqResult.decision === 'BLOCK') {
   *     await query(`UPDATE campaign_recipients SET status='skipped', error_detail=$1
   *                  WHERE id=$2`, [freqResult.reason, unit.id])
   *     return 'skipped'
   *   }
   *   // Proceder con Evolution API. NO llamar recordSend() después.
   *
   * @param evalInput   - Contexto de evaluación
   * @param recordInput - Datos para el registro en contact_send_history
   */
  static async atomicEvaluateAndRecord(
    evalInput:   FrequencyEvaluationInput,
    recordInput: RecordSendInput,
  ): Promise<FrequencyEvaluationResult> {
    const { contactId, operatorId, campaignId, segMonto, segActividad } = evalInput
    const evaluatedAt = new Date()

    const txResult = await withTransaction(async (client) => {

      // ── Paso 1: Advisory Lock ───────────────────────────────────────────────
      //
      // pg_advisory_xact_lock(namespace, key) adquiere un lock exclusivo de
      // transacción. Es BLOQUEANTE: espera hasta que el lock esté disponible.
      // Se libera automáticamente en el COMMIT o ROLLBACK de esta transacción.
      //
      // Dos argumentos int4: namespace=50 (este módulo) + hash del contactId.
      // Esto garantiza:
      //   ─ Locks de este módulo no colisionan con otros módulos del sistema.
      //   ─ Distintos contactos tienen distintos locks (sin contención cruzada).
      //   ─ El mismo contacto desde distintas líneas serializa correctamente.
      await client.query(
        `SELECT pg_advisory_xact_lock($1, hashtext($2))`,
        [ADVISORY_LOCK_NAMESPACE, contactId],
      )

      // ── Paso 2: Leer perfil (via pool — seguro mientras el lock está activo) ─
      //
      // El lock impide que cualquier otro proceso inserte en contact_send_history
      // para este contacto, por lo que la lectura es consistente.
      const profile = await historyRepo.getFrequencyProfile(contactId)

      // ── Paso 3: Resolver regla y calcular decisión ──────────────────────────
      const rules          = await rulesRepo.findActiveRulesForContext(operatorId)
      const applicableRule = resolveApplicableRule(rules, operatorId, segMonto, segActividad)
      const { decision, riskScore, reason } = calculateRiskScore(profile, applicableRule)

      // ── Paso 4: Pre-registrar si no es BLOCK ───────────────────────────────
      //
      // El registro ocurre DENTRO de esta transacción.
      // Al hacer COMMIT (que libera el lock), el slot ya está reservado en DB.
      // Otro proceso que intente adquirir el lock verá count+1 en su lectura.
      //
      // Si Evolution API falla después del COMMIT: el registro permanece.
      // Comportamiento INTENCIONAL: un intento fallido usa el slot (conservador).
      if (decision !== 'BLOCK') {
        await client.query(
          `INSERT INTO contact_send_history
             (contact_id, campaign_id, operator_id, phone_number, campaign_recipient_id, sent_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (campaign_recipient_id)
             WHERE campaign_recipient_id IS NOT NULL
           DO NOTHING`,
          [
            recordInput.contactId,
            recordInput.campaignId,
            recordInput.operatorId,
            recordInput.phoneNumber,
            recordInput.campaignRecipientId ?? null,
          ],
        )
      }
      // ── COMMIT aquí → lock liberado → otros pueden adquirirlo ──────────────

      return { decision, riskScore, reason, profile, applicableRule }
    })

    ContactFrequencyEngine.logDecision(
      txResult.decision, txResult.riskScore, txResult.reason,
      contactId, campaignId, operatorId, txResult.applicableRule.id,
      /* atomic */ true,
    )

    return { ...txResult, evaluatedAt }
  }

  /**
   * Registra un envío exitoso en el historial de frecuencia.
   *
   * Usar cuando se tomó la decisión con evaluate() (path no-atómico).
   * Si se usó atomicEvaluateAndRecord(), NO llamar este método — el registro
   * ya fue hecho durante la transacción atómica.
   *
   * Idempotente: llamada doble con el mismo campaignRecipientId → no-op.
   */
  static async recordSend(input: RecordSendInput): Promise<void> {
    await historyRepo.recordSend(input)
    console.log(
      `[freq-engine] recorded send ` +
      `contact=${input.contactId} ` +
      `campaign=${input.campaignId ?? 'n/a'} ` +
      `recipient=${input.campaignRecipientId ?? 'n/a'}`,
    )
  }

  /**
   * Expone los repositorios para operaciones administrativas y testing.
   * No usar en el path crítico de envío.
   */
  static get rulesRepository(): ContactFrequencyRulesRepository { return rulesRepo }
  static get historyRepository(): ContactSendHistoryRepository  { return historyRepo }

  // ── Helpers privados ────────────────────────────────────────────────────────

  private static logDecision(
    decision:   string,
    riskScore:  number,
    reason:     string,
    contactId:  string,
    campaignId: string | undefined,
    operatorId: string | null,
    ruleId:     string,
    atomic = false,
  ): void {
    const suffix = atomic ? ' (atomic)' : ''
    const ctx = [
      `contact=${contactId}`,
      `campaign=${campaignId ?? 'n/a'}`,
      `operator=${operatorId ?? 'system'}`,
      `rule=${ruleId}`,
      `score=${riskScore}`,
    ].join(' ')

    if (decision === 'BLOCK') {
      console.warn(`[freq-engine] BLOCK${suffix} ${ctx} reason="${reason}"`)
    } else if (decision === 'DELAY') {
      console.log(`[freq-engine] DELAY${suffix} ${ctx} reason="${reason}"`)
    } else {
      console.log(`[freq-engine] ALLOW${suffix} ${ctx}`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//
// ## Integración en campaign-distributor.ts
//
// ### Paso 1 — Importar el motor
//
//   import { ContactFrequencyEngine } from '@/lib/contact-frequency/ContactFrequencyEngine'
//
//
// ### Paso 2 — Reemplazar evaluate() + recordSend() por atomicEvaluateAndRecord()
//
// En sendOneUnit(), DESPUÉS de claimNextUnit() (línea ~657):
//
//   const freqResult = await ContactFrequencyEngine.atomicEvaluateAndRecord(
//     {
//       contactId:   unit.contact_id,
//       operatorId:  campaign.owned_by,
//       campaignId:  campaignId,
//     },
//     {
//       contactId:            unit.contact_id,
//       campaignId:           campaignId,
//       operatorId:           campaign.owned_by,
//       phoneNumber:          unit.phone_number,
//       campaignRecipientId:  unit.id,
//     },
//   )
//
//   if (freqResult.decision === 'BLOCK') {
//     console.log(
//       `[distributor ${campaignId}] freq-blocked ${unit.phone_number}: ${freqResult.reason}`
//     )
//     await query(`
//       UPDATE campaign_recipients
//       SET status = 'skipped', error_detail = $1, failed_at = NOW()
//       WHERE id = $2
//     `, [freqResult.reason, unit.id])
//     return 'skipped'
//   }
//   // Si decision=DELAY: continuar de todos modos (delay humanizado ya actúa).
//   // NO llamar recordSend() — el registro ya fue hecho en atomicEvaluateAndRecord().
//
//
// ### Paso 3 — Eliminar la llamada a recordSend() de handleSuccess()
//
// Si ya se usa atomicEvaluateAndRecord(), NO agregar recordSend() en handleSuccess().
// El slot fue reservado en la transacción atómica, antes del envío a Evolution.
//
// ═══════════════════════════════════════════════════════════════════════════════
