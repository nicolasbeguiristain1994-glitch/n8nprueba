/**
 * automation-engine.ts
 *
 * Motor de evaluación y ejecución de automatizaciones.
 * Se invoca desde el webhook de Evolution al recibir un mensaje inbound.
 *
 * Flujo:
 *   1. Cargar automatizaciones activas (ordenadas por prioridad)
 *   2. Verificar anti-loop: si el mismo message_id ya tiene un log → skip
 *   3. Si la conversación está escalada → skip automations
 *   4. Evaluar triggers en orden de prioridad
 *   5. Ejecutar la primera que coincida
 *   6. Registrar log
 *
 * Prevención de loops:
 *   - Solo procesa mensajes inbound
 *   - Idempotencia por message_id en automation_logs
 *   - Cooldown de 10 segundos entre ejecuciones por phone
 *   - No auto-responde si ya hay un outbound reciente de automation
 */

import { query } from '@/lib/db'

// ── Tipos internos ────────────────────────────────────────────────────────────

type AutomationType    = 'reply' | 'flow' | 'handoff'
type TriggerType       = 'keyword' | 'contains' | 'any_inbound'

interface TriggerConfig {
  keywords?: string[]
}

interface ReplyActionConfig {
  message: string
}

interface FlowActionConfig {
  steps: Array<{ message: string; delay_sec?: number }>
}

interface HandoffActionConfig {
  message?: string
}

type ActionConfig = ReplyActionConfig | FlowActionConfig | HandoffActionConfig

interface Automation {
  id: string
  name: string
  type: AutomationType
  trigger_type: TriggerType
  trigger_config: TriggerConfig
  action_config: ActionConfig
  priority: number
}

interface ContactInfo {
  first_name: string | null
  panel: string | null
}

// ── Normalización de texto para matching ─────────────────────────────────────

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Evaluación de trigger ─────────────────────────────────────────────────────

function matchesTrigger(
  automation: Automation,
  messageText: string,
): boolean {
  const { trigger_type, trigger_config } = automation
  const normalized = normalizeForMatch(messageText)

  if (trigger_type === 'any_inbound') {
    return true
  }

  const keywords = (trigger_config.keywords ?? []).map(k => normalizeForMatch(k)).filter(Boolean)
  if (keywords.length === 0) return false

  if (trigger_type === 'keyword') {
    // Coincidencia exacta con alguna keyword
    return keywords.some(kw => normalized === kw)
  }

  if (trigger_type === 'contains') {
    // El mensaje contiene alguna keyword
    return keywords.some(kw => normalized.includes(kw))
  }

  return false
}

// ── Sustitución de variables ──────────────────────────────────────────────────

function resolveVariables(template: string, contact: ContactInfo | null): string {
  const nombre = contact?.first_name?.trim() || 'Cliente'
  const empresa = contact?.panel?.trim() || ''
  const fecha = new Date().toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })

  return template
    .replace(/\{\{nombre\}\}/gi, nombre)
    .replace(/\{\{empresa\}\}/gi, empresa)
    .replace(/\{\{fecha\}\}/gi, fecha)
}

// ── Envío de mensaje de automatización ───────────────────────────────────────

async function sendAutoMessage(
  phone: string,
  message: string,
  automationId: string,
): Promise<boolean> {
  // Elegir línea activa aleatoria para distribuir carga
  const lines = await query<{ id: string; evolution_url: string; evolution_instance: string }>(
    `SELECT id, evolution_url, evolution_instance
     FROM whatsapp_lines
     WHERE active = true AND status = 'connected'
     ORDER BY RANDOM()
     LIMIT 1`,
  )

  if (lines.length === 0) {
    console.warn('[automation-engine] No hay líneas conectadas para enviar auto-respuesta')
    return false
  }

  const line = lines[0]
  const apiKey = process.env.EVOLUTION_API_KEY ?? ''

  try {
    const res = await fetch(
      `${line.evolution_url}/message/sendText/${line.evolution_instance}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body: JSON.stringify({ number: phone, text: message }),
      },
    )

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('[automation-engine] Evolution API error:', res.status, errText.slice(0, 200))
      return false
    }

    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    const key = data?.key as Record<string, unknown> | undefined
    const msgId = (key?.id as string) || (data?.id as string) || null

    // Registrar mensaje saliente en whatsapp_messages
    const phoneFormatted = phone.startsWith('+') ? phone : `+${phone}`
    await query(
      `INSERT INTO whatsapp_messages
         (phone_number, message_body, direction, status, evolution_message_id, metadata)
       VALUES ($1, $2, 'outbound', 'sent', $3, $4::jsonb)`,
      [
        phoneFormatted,
        message,
        msgId,
        JSON.stringify({ source: 'automation', automation_id: automationId }),
      ],
    )

    return true
  } catch (e) {
    console.error('[automation-engine] sendAutoMessage error:', e instanceof Error ? e.message : e)
    return false
  }
}

// ── Ejecutar acción de handoff ────────────────────────────────────────────────

async function executeHandoff(
  phone: string,
  automation: Automation,
  contact: ContactInfo | null,
): Promise<void> {
  const config = automation.action_config as HandoffActionConfig

  // Enviar mensaje previo si está configurado
  if (config.message?.trim()) {
    const resolved = resolveVariables(config.message, contact)
    await sendAutoMessage(phone, resolved, automation.id)
  }

  // Marcar conversación como escalada en conversation_state
  await query(
    `INSERT INTO conversation_state
       (phone_number, is_escalated, escalated_at, escalation_reason)
     VALUES ($1, true, NOW(), $2)
     ON CONFLICT (phone_number) WHERE resolved_at IS NULL
     DO UPDATE SET
       is_escalated      = true,
       escalated_at      = NOW(),
       escalation_reason = EXCLUDED.escalation_reason,
       updated_at        = NOW()`,
    [phone, `Automatización: ${automation.name}`],
  )
}

// ── Log de ejecución ──────────────────────────────────────────────────────────

async function logExecution(
  automationId: string,
  automationName: string,
  phone: string,
  messageId: string | null,
  result: 'executed' | 'skipped' | 'error',
  details?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO automation_logs
         (automation_id, automation_name, conversation_phone, message_id, result, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [automationId, automationName, phone, messageId, result, details ?? null],
    )
  } catch (e) {
    console.error('[automation-engine] error al registrar log:', e instanceof Error ? e.message : e)
  }
}

// ── Entry point público ───────────────────────────────────────────────────────

/**
 * Evalúa y ejecuta automatizaciones activas para un mensaje inbound.
 * Nunca lanza excepciones — todos los errores se capturan internamente.
 *
 * @param phone        Número de teléfono del remitente (sin '+', ej: "5491155551234")
 * @param messageText  Texto del mensaje inbound
 * @param messageId    UUID del mensaje en whatsapp_messages (para idempotencia)
 */
export async function evaluateAutomations(
  phone: string,
  messageText: string,
  messageId: string | null,
): Promise<void> {
  try {
    // ── 1. Idempotencia por message_id ────────────────────────────────────────
    if (messageId) {
      const existing = await query<{ id: string }>(
        `SELECT id FROM automation_logs WHERE message_id = $1 LIMIT 1`,
        [messageId],
      )
      if (existing.length > 0) {
        // Ya fue procesado (reentrega del webhook o doble disparo)
        return
      }
    }

    // ── 2. Verificar si la conversación ya está escalada ──────────────────────
    const convState = await query<{ is_escalated: boolean }>(
      `SELECT is_escalated FROM conversation_state
       WHERE phone_number = $1 AND resolved_at IS NULL
       LIMIT 1`,
      [phone],
    )
    if (convState[0]?.is_escalated === true) {
      // Conversación en manos de humano — no intervenir
      return
    }

    // ── 3. Anti-loop: cooldown de 10 segundos por phone ───────────────────────
    const recentLog = await query<{ id: string }>(
      `SELECT id FROM automation_logs
       WHERE conversation_phone = $1
         AND result = 'executed'
         AND created_at > NOW() - INTERVAL '10 seconds'
       LIMIT 1`,
      [phone],
    )
    if (recentLog.length > 0) {
      // Otra automatización ejecutó hace menos de 10s — evitar loop
      return
    }

    // ── 4. Cargar automatizaciones activas ────────────────────────────────────
    const automations = await query<Automation>(
      `SELECT id, name, type, trigger_type, trigger_config, action_config, priority
       FROM automations
       WHERE is_active = true
       ORDER BY priority ASC, created_at ASC`,
    )

    if (automations.length === 0) return

    // ── 5. Buscar contacto para variables ─────────────────────────────────────
    const phoneFormatted = phone.startsWith('+') ? phone : `+${phone}`
    const contacts = await query<ContactInfo>(
      `SELECT first_name, panel FROM contacts WHERE phone_number = $1 LIMIT 1`,
      [phoneFormatted],
    )
    const contact = contacts[0] ?? null

    // ── 6. Evaluar automaciones en orden ──────────────────────────────────────
    for (const automation of automations) {
      if (!matchesTrigger(automation, messageText)) continue

      // ── 7. Ejecutar acción ────────────────────────────────────────────────
      try {
        if (automation.type === 'handoff') {
          await executeHandoff(phone, automation, contact)
          await logExecution(automation.id, automation.name, phone, messageId, 'executed', 'handoff ejecutado')

        } else if (automation.type === 'reply') {
          const config = automation.action_config as ReplyActionConfig
          const resolved = resolveVariables(config.message ?? '', contact)
          const sent = await sendAutoMessage(phone, resolved, automation.id)
          await logExecution(
            automation.id, automation.name, phone, messageId,
            sent ? 'executed' : 'error',
            sent ? undefined : 'Fallo al enviar auto-respuesta (sin líneas o error Evolution)',
          )

        } else if (automation.type === 'flow') {
          const config = automation.action_config as FlowActionConfig
          const steps = config.steps ?? []
          // Para MVP: enviar solo el primer paso inmediatamente
          // Los pasos posteriores con delay requieren un worker/scheduler externo
          if (steps.length > 0) {
            const resolved = resolveVariables(steps[0].message ?? '', contact)
            const sent = await sendAutoMessage(phone, resolved, automation.id)
            await logExecution(
              automation.id, automation.name, phone, messageId,
              sent ? 'executed' : 'error',
              sent ? `Flujo iniciado (paso 1 de ${steps.length})` : 'Fallo al enviar primer paso',
            )
          }
        }

        // Solo se ejecuta la PRIMERA automatización que coincide
        break

      } catch (execErr) {
        console.error('[automation-engine] error ejecutando automatización', automation.id, execErr instanceof Error ? execErr.message : execErr)
        await logExecution(automation.id, automation.name, phone, messageId, 'error',
          execErr instanceof Error ? execErr.message : 'Error desconocido')
        break
      }
    }

  } catch (e) {
    // El engine nunca debe romper el flujo del webhook
    console.error('[automation-engine] error general:', e instanceof Error ? e.message : e)
  }
}
