import { query } from '@/lib/db'
import { getConfigRedisClient } from '@/lib/redis'

const CACHE_TTL_SECONDS = 300

/**
 * Lee un setting del sistema desde app_settings.
 * Retorna el valor parseado, o `fallback` si no existe o falla.
 * Uso: await getAppSetting<boolean>('perms_contacts_export_global', true)
 *
 * Tres capas de fallback:
 *   1. Redis (cache:TTL 300s) — si HIT, retorna sin ir a DB
 *   2. DB  — query a app_settings; guarda en Redis para siguientes lecturas
 *   3. fallback param — retornado si DB también falla
 *
 * Si REDIS_URL no está configurada, degrada silenciosamente a solo DB.
 * Nunca lanza excepción por Redis no disponible.
 */
export async function getAppSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const cacheKey = `app_settings:${key}`

  // Capa 1: Redis
  try {
    const client = getConfigRedisClient()
    if (client) {
      const cached = await client.get(cacheKey)
      if (cached !== null) return JSON.parse(cached) as T
    }
  } catch {
    // Redis no disponible — continuar a DB silenciosamente
  }

  // Capa 2: DB
  try {
    const rows = await query<{ value: T }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key],
    )
    if (!rows[0]) return fallback

    // Cachear en Redis para las próximas lecturas
    try {
      const client = getConfigRedisClient()
      if (client) {
        await client.setEx(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(rows[0].value))
      }
    } catch {
      // Falla silenciosa de escritura a Redis — no bloquear el flujo principal
    }

    return rows[0].value as T
  } catch {
    // Capa 3: fallback param
    return fallback
  }
}
