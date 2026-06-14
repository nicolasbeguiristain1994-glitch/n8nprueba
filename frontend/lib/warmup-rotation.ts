/**
 * warmup-rotation.ts
 *
 * Historial de rotación de mensajes para el módulo de warmup, respaldado por Redis.
 *
 * PROBLEMA que resuelve:
 *   warmup-engine.ts mantiene el historial en un `Map` en memoria de Node.js.
 *   En entornos serverless (Next.js / Vercel), cada invocación puede arrancar
 *   en una instancia diferente con el Map vacío. El resultado es que
 *   `getNextWarmupMessage()` nunca excluye mensajes recientes → el mismo texto
 *   puede enviarse en invocaciones consecutivas, generando patrones detectables
 *   por WhatsApp.
 *
 * SOLUCIÓN:
 *   Este módulo persiste el historial en Redis con TTL de 48h.
 *   Las funciones son compatibles con la interfaz de warmup-engine.ts:
 *   `getRecentMessages(lineId)` devuelve el array para pasarlo como
 *   `recentMessages` en `getNextWarmupMessage()`.
 *
 * DEGRADACIÓN SEGURA:
 *   Si REDIS_URL no está configurada o Redis no responde, todas las funciones
 *   resuelven sin error (vacío / no-op). El warmup sigue funcionando con
 *   deduplicación solo in-memory (comportamiento anterior).
 *
 * ESTRUCTURA DE CLAVE:
 *   warmup:rotation:<lineId>   → Redis List
 *   - LPUSH: el más reciente queda en índice 0
 *   - LTRIM: max HISTORY_LIMIT entradas
 *   - EXPIRE: ROTATION_TTL_SECONDS (48h) — se renueva en cada escritura
 *
 * USO TÍPICO en process/route.ts:
 *   const recent  = await getRecentMessages(line.id)
 *   const msgData = getNextWarmupMessage(line.id, phase, recent)
 *   if (sendOk) await recordSentMessage(line.id, msgData.content)
 */

import { getConfigRedisClient } from './redis'

// ── Constantes ─────────────────────────────────────────────────────────────────

const KEY_PREFIX         = 'warmup:rotation:'
const HISTORY_LIMIT      = 20       // entradas máximas por línea (≈ pool de mensajes)
const ROTATION_TTL_SECS  = 48 * 3600  // 48 horas — coincide con ROTATION_WINDOW_MS

// ── Helpers privados ───────────────────────────────────────────────────────────

function redisKey(lineId: string): string {
  return `${KEY_PREFIX}${lineId}`
}

// ── API pública ────────────────────────────────────────────────────────────────

/**
 * Devuelve los últimos HISTORY_LIMIT contenidos de mensajes enviados por esta
 * línea (más reciente primero).
 *
 * Pasar el resultado directamente como `recentMessages` en getNextWarmupMessage()
 * para que el motor excluya esos textos del pool de selección.
 *
 * @returns Array de strings (contenido de mensajes). Vacío si Redis no disponible.
 */
export async function getRecentMessages(lineId: string): Promise<string[]> {
  try {
    const client = getConfigRedisClient()
    if (!client) return []
    return await client.lRange(redisKey(lineId), 0, HISTORY_LIMIT - 1)
  } catch (err) {
    console.warn(
      '[warmup-rotation] getRecentMessages — Redis no disponible (degradando a sin dedup):',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

/**
 * Registra un mensaje enviado exitosamente para evitar que se repita en las
 * próximas 48h en la misma línea.
 *
 * Llamar SOLO después de un envío exitoso confirmado por Evolution API.
 * Los fallos no se registran (no queremos excluir mensajes que nunca llegaron).
 *
 * Fire-and-forget seguro: los errores se loggean pero no propagan al caller.
 */
export async function recordSentMessage(lineId: string, content: string): Promise<void> {
  try {
    const client = getConfigRedisClient()
    if (!client) return

    const k = redisKey(lineId)
    // Pipeline atómico: push + trim + expire en un solo round-trip
    const pipeline = client.multi()
    pipeline.lPush(k, content)
    pipeline.lTrim(k, 0, HISTORY_LIMIT - 1)
    pipeline.expire(k, ROTATION_TTL_SECS)
    await pipeline.exec()
  } catch (err) {
    // No-fatal: el warmup continúa sin deduplicación Redis para este mensaje
    console.warn(
      '[warmup-rotation] recordSentMessage — error no fatal:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Elimina el historial de rotación de una línea.
 * Llamar al completar el warmup o hacer un reset manual de la línea.
 */
export async function clearLineRotationHistory(lineId: string): Promise<void> {
  try {
    const client = getConfigRedisClient()
    if (!client) return
    await client.del(redisKey(lineId))
  } catch (err) {
    console.warn(
      '[warmup-rotation] clearLineRotationHistory — error no fatal:',
      err instanceof Error ? err.message : err,
    )
  }
}
