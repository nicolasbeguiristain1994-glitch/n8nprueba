import { createClient } from 'redis'

type RedisClient = ReturnType<typeof createClient>

let _client: RedisClient | null = null

/**
 * Retorna el cliente Redis singleton para caching de configuración.
 * Retorna null si REDIS_URL no está configurada → degradación silenciosa a DB.
 *
 * Patrón: mismo que cloud-api/rate-limiter.ts y rate-limit.ts del proyecto.
 * Un cliente Redis por proceso — compartido entre segmentation-config-service,
 * scoring-config-service y app-settings para evitar múltiples conexiones.
 */
export function getConfigRedisClient(): RedisClient | null {
  if (!process.env.REDIS_URL) return null
  if (!_client) {
    _client = createClient({ url: process.env.REDIS_URL })
    _client.connect().catch(err =>
      console.warn('[config-cache] Redis connect error — degrading to DB only:', err)
    )
  }
  return _client
}
