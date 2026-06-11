import { getConfigRedisClient } from '@/lib/redis'

// TTL separados: admins ven datos globales (cacheable más tiempo),
// operadores ven datos filtrados por visibilidad (TTL más corto).
const ADMIN_TTL_S    = 120  // 2 minutos
const OPERATOR_TTL_S = 60   // 1 minuto

function cacheKey(role: string, userId: string): string {
  // Admins comparten un único key; operadores tienen key propio.
  return role === 'admin'
    ? 'dashboard:stats:admin:v1'
    : `dashboard:stats:op:${userId}:v1`
}

/**
 * Stale-while-revalidate para stats del dashboard.
 * Si Redis no está disponible, ejecuta computeFn directamente (degradación silenciosa).
 */
export async function getCachedDashboardStats<T>(
  role: string,
  userId: string,
  computeFn: () => Promise<T>,
): Promise<T> {
  const redis = getConfigRedisClient()
  const key   = cacheKey(role, userId)
  const ttl   = role === 'admin' ? ADMIN_TTL_S : OPERATOR_TTL_S

  if (redis?.isReady) {
    try {
      const cached = await redis.get(key)
      if (cached) return JSON.parse(cached) as T
    } catch (e) {
      console.warn('[dashboard-cache] Redis get error — computing fresh:', (e as Error).message)
    }
  }

  const result = await computeFn()

  if (redis?.isReady) {
    // fire-and-forget: no bloquea el response al usuario
    redis.setEx(key, ttl, JSON.stringify(result)).catch(e =>
      console.warn('[dashboard-cache] Redis setEx error:', (e as Error).message)
    )
  }

  return result
}

/**
 * Invalida el cache del dashboard para un usuario específico o para admins.
 * Llamar desde endpoints que modifican datos que aparecen en el dashboard
 * (ej: sync manual de casino, envío de campaña completado).
 */
export async function invalidateDashboardCache(role: string, userId: string): Promise<void> {
  const redis = getConfigRedisClient()
  if (!redis?.isReady) return
  await redis.del(cacheKey(role, userId)).catch(() => {})
}

/**
 * Invalida el cache de todos los admins (útil post-sync global).
 */
export async function invalidateAdminDashboardCache(): Promise<void> {
  const redis = getConfigRedisClient()
  if (!redis?.isReady) return
  await redis.del('dashboard:stats:admin:v1').catch(() => {})
}
