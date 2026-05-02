/**
 * proxy-manager.ts
 *
 * Capa de gestión de proxies en el hot path de envío.
 *
 * ─── Por qué este módulo existe ───────────────────────────────────────────────
 *
 * distributor.ts resuelve CUÁL proxy se asigna a CUÁL línea en la DB.
 * Ese es un problema de planificación (advisory, batch, admin UI).
 *
 * proxy-manager.ts resuelve CÓMO se aplica ese proxy en cada mensaje en tiempo
 * real: cache en memoria, formateo de URL, health tracking desde errores reales
 * de envío, blacklist temporal, y configuración de la instancia Evolution.
 *
 * ─── Cómo se aplican los proxies realmente en Evolution API ───────────────────
 *
 * Evolution API v2 soporta proxy por instancia. Hay DOS momentos donde se
 * configura:
 *
 *   1. Al ASIGNAR o ROTAR el proxy (rotateProxyForLine / applyProxyToEvolution):
 *      Se llama al endpoint de Evolution para actualizar la configuración de la
 *      instancia. A partir de ese momento, el proceso de Baileys (WhatsApp Web)
 *      de esa instancia usará ese proxy para toda la conexión de red.
 *
 *   2. En cada ENVÍO (getProxyForLine):
 *      El fetch a Evolution API (management) puede también ir via proxy si se
 *      usa un ProxyAgent. En la mayoría de los setups esto no es necesario porque
 *      la llamada management va de servidor a servidor (Railway→Evolution), pero
 *      se documenta la opción.
 *
 * Evolution API v2 — endpoint de configuración de proxy por instancia:
 *   PUT {evolutionUrl}/instance/update/{instanceName}
 *   Headers: { apikey: EVOLUTION_API_KEY }
 *   Body: {
 *     proxyHost:     "proxy.example.com",
 *     proxyPort:     "8080",
 *     proxyProtocol: "http" | "https" | "socks5",
 *     proxyUsername: "user",   // omitir si sin auth
 *     proxyPassword: "pass",   // omitir si sin auth
 *   }
 *
 * NOTA: Si tu versión de Evolution API no soporta este endpoint, ver la sección
 * "Arquitectura alternativa" al final del archivo.
 */

import { query } from '@/lib/db'
import { rotateProxy as distributorRotateProxy } from '@/lib/distributor'

// ── Tipos ──────────────────────────────────────────────────────────────────────

export type ProxyProtocol = 'http' | 'https' | 'socks5'
export type ProxyType     = 'datacenter' | 'residential' | 'mobile'
export type ProxyHealth   = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

/**
 * Configuración de proxy lista para usar: URL formateada, credenciales, metadatos.
 * Es la representación "runtime" del registro ProxyRow de la DB.
 */
export interface ProxyConfig {
  /** UUID del registro en la tabla proxies. */
  id:            string
  /** Label del proxy para logging. */
  label:         string
  /**
   * URL completa del proxy.
   * Formato: protocol://user:pass@host:port  (si tiene credenciales)
   *          protocol://host:port             (si no tiene)
   * Úsala directamente en undici/node-fetch/https-proxy-agent.
   */
  url:           string
  protocol:      ProxyProtocol
  host:          string
  port:          number
  username:      string | null
  password:      string | null
  proxyType:     ProxyType
  country:       string | null
  /** Si true, el endpoint rota la IP en cada request. No usar sticky con este flag. */
  isRotating:    boolean
  health:        ProxyHealth
}

/** Entrada de la blacklist temporal en memoria. */
interface TempBlacklistEntry {
  failureCount: number
  firstFailAt:  number  // Date.now()
  lastFailAt:   number
  lastReason:   string
}

/** Entrada del cache en memoria: ProxyConfig + timestamp de fetch. */
interface CacheEntry {
  config:     ProxyConfig | null  // null = línea sin proxy asignado
  fetchedAt:  number
}

// ── Constantes ─────────────────────────────────────────────────────────────────

/** TTL del cache en memoria antes de refrescar desde DB. */
const CACHE_TTL_MS = 5 * 60 * 1000                   // 5 minutos

/**
 * Cuántos fallos consecutivos de red para marcar un proxy como 'degraded'.
 * A partir de UNHEALTHY_THRESHOLD se marca 'unhealthy' directamente.
 */
const DEGRADED_THRESHOLD  = 2
const UNHEALTHY_THRESHOLD = 5

/**
 * Cooldown para proxies 'degraded': no se asignan a nuevas líneas durante
 * este tiempo, pero las líneas que ya lo usan siguen intentando.
 */
const DEGRADED_COOLDOWN_MS = 30 * 60 * 1000          // 30 minutos

// ── Stores en memoria ──────────────────────────────────────────────────────────

/** Cache principal: lineId → { ProxyConfig | null, fetchedAt } */
const proxyCache = new Map<string, CacheEntry>()

/**
 * Blacklist temporal: proxyId → TempBlacklistEntry.
 * Vive solo en memoria; se resetea si el proceso se reinicia.
 * Los cambios de health permanentes se persisten en DB via markProxyHealth().
 */
const tempBlacklist = new Map<string, TempBlacklistEntry>()

// ── buildProxyUrl ──────────────────────────────────────────────────────────────

/**
 * Construye la URL completa del proxy con credenciales embebidas si las tiene.
 * El formato es compatible con https-proxy-agent, socks-proxy-agent, y undici.
 *
 * ⚠️ La contraseña se embebe en la URL. Esto es intencional y estándar para
 * proxy URLs, pero no loguees esta URL en texto plano en producción.
 */
function buildProxyUrl(row: {
  protocol: string
  username: string | null
  password: string | null
  host:     string
  port:     number
}): string {
  const auth = row.username
    ? `${encodeURIComponent(row.username)}:${encodeURIComponent(row.password ?? '')}@`
    : ''
  return `${row.protocol}://${auth}${row.host}:${row.port}`
}

/**
 * Resuelve el valor de password_ref al password real.
 *
 * El schema de DB documenta password_ref como "non-secret reference only
 * (e.g. env variable name, vault path)" — no el password en crudo.
 *
 * Convención de resolución:
 *   - Patrón env var (solo A-Z, 0-9, guión bajo, empieza con letra):
 *       'PROXY_PASS_001' → process.env['PROXY_PASS_001']
 *   - Cualquier otro valor → se usa directamente (legacy / desarrollo local)
 *
 * Ejemplos:
 *   'PROXY_PASS_001' → process.env.PROXY_PASS_001  (producción)
 *   's3cr3t!'        → 's3cr3t!'                    (dev / legacy directo)
 *   null             → null                          (proxy sin auth)
 */
function resolvePasswordRef(ref: string | null): string | null {
  if (!ref) return null
  if (/^[A-Z][A-Z0-9_]+$/.test(ref)) {
    const resolved = process.env[ref]
    if (!resolved) {
      console.warn(`[proxy-manager] password_ref "${ref}" no encontrado en process.env — proxy sin auth`)
    }
    return resolved ?? null
  }
  return ref
}

/** Construye un ProxyConfig desde una fila de la tabla proxies. */
function rowToConfig(row: {
  id:               string
  label:            string
  protocol:         string
  host:             string
  port:             number
  username:         string | null
  password_ref:     string | null
  proxy_type:       string
  country:          string | null
  rotating_endpoint: boolean
  health_status:    string
}): ProxyConfig {
  const resolvedPassword = resolvePasswordRef(row.password_ref)
  return {
    id:         row.id,
    label:      row.label,
    url:        buildProxyUrl({
      protocol: row.protocol,
      username: row.username,
      password: resolvedPassword,
      host:     row.host,
      port:     row.port,
    }),
    protocol:   row.protocol  as ProxyProtocol,
    host:       row.host,
    port:       row.port,
    username:   row.username,
    password:   resolvedPassword,
    proxyType:  row.proxy_type as ProxyType,
    country:    row.country,
    isRotating: row.rotating_endpoint,
    health:     row.health_status as ProxyHealth,
  }
}

// ── getProxyForLine ────────────────────────────────────────────────────────────

/**
 * Devuelve el proxy asignado a una línea, usando cache en memoria.
 *
 * Flujo:
 *   1. Hit de cache fresco (< 5 min) → devolver sin DB
 *   2. Cache expirado o miss → consultar DB (whatsapp_lines JOIN proxies)
 *   3. Si el proxy está en la blacklist temporal y > DEGRADED_COOLDOWN_MS,
 *      intentar rotación automática silenciosa.
 *
 * Devuelve null si:
 *   - La línea no tiene proxy asignado
 *   - El proxy asignado está inactive o unhealthy en DB
 *
 * @param lineId  UUID de la línea (whatsapp_lines.id)
 */
export async function getProxyForLine(lineId: string): Promise<ProxyConfig | null> {
  // ── Cache check ────────────────────────────────────────────────────────────
  const cached = proxyCache.get(lineId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.config
  }

  // ── DB lookup ──────────────────────────────────────────────────────────────
  const rows = await query<{
    id: string; label: string; protocol: string; host: string; port: number
    username: string | null; password_ref: string | null; proxy_type: string
    country: string | null; rotating_endpoint: boolean; health_status: string
    is_active: boolean
  }>(
    `SELECT p.id, p.label, p.protocol, p.host, p.port, p.username, p.password_ref,
            p.proxy_type, p.country, p.rotating_endpoint, p.health_status, p.is_active
     FROM whatsapp_lines wl
     JOIN proxies p ON p.id = wl.proxy_id
     WHERE wl.id = $1
       AND p.is_active = true
       AND p.health_status != 'unhealthy'`,
    [lineId]
  )

  const config = rows[0] ? rowToConfig(rows[0]) : null
  proxyCache.set(lineId, { config, fetchedAt: Date.now() })

  // ── Blacklist check ────────────────────────────────────────────────────────
  // Si el proxy está en la blacklist temporal con cooldown activo, intentar
  // rotación silenciosa para no bloquear el envío en curso.
  if (config && isProxyInCooldown(config.id)) {
    console.warn(
      `[proxy-manager] proxy ${config.label} (${config.id.slice(0, 8)}) ` +
      `en cooldown para línea ${lineId} — intentando rotación silenciosa`
    )
    const rotated = await rotateProxyForLine(lineId).catch(() => null)

    if (!rotated) {
      // Rotación fallida: cachear "sin proxy" por 60 s para evitar que la
      // próxima llamada reintente rotar inmediatamente (rotation loop).
      // rotateProxyForLine ya hizo proxyCache.delete(), así que el cache
      // quedaría vacío → cache miss → DB lookup → mismo proxy en cooldown → loop.
      proxyCache.set(lineId, {
        config:    null,
        fetchedAt: Date.now() - CACHE_TTL_MS + 60_000,
      })
    }

    return rotated
  }

  return config
}

// ── getBestAvailableProxy ──────────────────────────────────────────────────────

/**
 * Encuentra el mejor proxy disponible en la flota sin asignarlo.
 * Útil para previews, auditorías, y para verificar si hay proxies antes
 * de pausar una campaña.
 *
 * Excluye proxies en cooldown de la blacklist temporal.
 */
export async function getBestAvailableProxy(lineId?: string): Promise<ProxyConfig | null> {
  const blacklistedIds = getCooldownProxyIds()

  // Build params and SQL placeholders separately to avoid index mismatch.
  // When lineId is absent, blacklist params start at $1, not $2.
  const params: unknown[] = []
  let   paramIdx = 0

  const stickyClause = lineId
    ? (() => {
        params.push(lineId)
        return `(p.id IN (SELECT proxy_id FROM whatsapp_lines WHERE id = $${++paramIdx})) DESC,`
      })()
    : ''

  const blacklistClause = blacklistedIds.length > 0
    ? `AND p.id != ALL(ARRAY[${
        blacklistedIds.map(id => {
          params.push(id)
          return `$${++paramIdx}`
        }).join(',')
      }]::uuid[])`
    : ''

  const rows = await query<{
    id: string; label: string; protocol: string; host: string; port: number
    username: string | null; password_ref: string | null; proxy_type: string
    country: string | null; rotating_endpoint: boolean; health_status: string
    is_active: boolean
  }>(
    `SELECT p.id, p.label, p.protocol, p.host, p.port, p.username, p.password_ref,
            p.proxy_type, p.country, p.rotating_endpoint, p.health_status, p.is_active
     FROM proxies p
     WHERE p.is_active      = true
       AND p.health_status != 'unhealthy'
       ${blacklistClause}
     ORDER BY
       ${stickyClause}
       CASE p.proxy_type
         WHEN 'mobile'      THEN 0
         WHEN 'residential' THEN 1
         ELSE                    2
       END,
       CASE p.health_status
         WHEN 'healthy' THEN 0
         WHEN 'unknown' THEN 1
         ELSE                2
       END,
       COALESCE(p.latency_ms, 9999) ASC
     LIMIT 1`,
    params
  )

  return rows[0] ? rowToConfig(rows[0]) : null
}

// ── markProxyHealth ────────────────────────────────────────────────────────────

/**
 * Actualiza el estado de salud de un proxy en la DB y loguea el motivo.
 * Invalida el cache de todas las líneas que usan ese proxy.
 *
 * Llamar cuando se detecta un problema confirmado (no solo un fallo de red
 * aislado — para eso usar reportProxySendFailure que tiene threshold).
 */
export async function markProxyHealth(
  proxyId: string,
  health:  ProxyHealth,
  reason?: string,
): Promise<void> {
  await query(
    `UPDATE proxies
     SET health_status = $1,
         last_checked_at = NOW(),
         updated_at = NOW()
     WHERE id = $2`,
    [health, proxyId]
  )

  if (reason) {
    console.log(
      `[proxy-manager] proxy ${proxyId.slice(0, 8)} → ${health}` +
      (reason ? `: ${reason}` : '')
    )
  }

  // Incrementar bans_detected si se marca unhealthy (posible ban de IP)
  if (health === 'unhealthy') {
    await query(
      `UPDATE proxies SET bans_detected = bans_detected + 1 WHERE id = $1`,
      [proxyId]
    ).catch(() => {})
  }

  // Al restaurar a healthy, limpiar la entrada de la blacklist en memoria.
  // Sin esto, un proxy reparado por el operador seguiría bloqueado en runtime
  // hasta el siguiente restart del proceso (isProxyInCooldown devolvía true para siempre).
  if (health === 'healthy') {
    tempBlacklist.delete(proxyId)
  }

  // Invalidar el cache de todas las líneas que usan este proxy
  await invalidateCacheByProxyId(proxyId)
}

// ── reportProxySendFailure ─────────────────────────────────────────────────────

/**
 * Registra un fallo de envío atribuible al proxy y escala el health si
 * el número de fallos supera los umbrales configurados.
 *
 * Solo llamar cuando el error sea de RED (timeout, ECONNREFUSED, ENOTFOUND),
 * no cuando sea un error de WhatsApp (número inválido, banned number, etc.).
 * Ver `isNetworkError()` en campaign-distributor.ts.
 *
 * Lógica de escalada:
 *   1–2 fallos  → blacklist temporal con cooldown (sin cambio en DB)
 *   3–4 fallos  → marcar 'degraded' en DB
 *   5+ fallos   → marcar 'unhealthy' en DB + rotar proxy de la línea afectada
 */
export async function reportProxySendFailure(
  proxyId: string,
  lineId:  string,
  reason:  string,
): Promise<void> {
  const now     = Date.now()
  const existing = tempBlacklist.get(proxyId)

  const entry: TempBlacklistEntry = existing
    ? { ...existing, failureCount: existing.failureCount + 1, lastFailAt: now, lastReason: reason }
    : { failureCount: 1, firstFailAt: now, lastFailAt: now, lastReason: reason }

  tempBlacklist.set(proxyId, entry)

  console.warn(
    `[proxy-manager] proxy ${proxyId.slice(0, 8)} fallo #${entry.failureCount} ` +
    `en línea ${lineId}: ${reason}`
  )

  // Usar === para que cada transición escriba en DB una sola vez.
  // Con >= se hacían 3 UPDATE redundantes (counts 2, 3, 4 → todos 'degraded').
  if (entry.failureCount === UNHEALTHY_THRESHOLD) {
    await markProxyHealth(proxyId, 'unhealthy', `${entry.failureCount} fallos: ${reason}`)
    // Rotar el proxy de la línea afectada automáticamente
    await rotateProxyForLine(lineId).catch(e =>
      console.error(`[proxy-manager] rotación automática fallida para ${lineId}:`, e)
    )
  } else if (entry.failureCount === DEGRADED_THRESHOLD) {
    await markProxyHealth(proxyId, 'degraded', `${entry.failureCount} fallos: ${reason}`)
  }
  // < DEGRADED_THRESHOLD: solo blacklist temporal, sin cambio en DB
}

// ── rotateProxyForLine ─────────────────────────────────────────────────────────

/**
 * Fuerza la rotación del proxy de una línea.
 *
 * Flujo:
 *   1. Delegar selección y persistencia a distributor.rotateProxy (lógica ya probada)
 *   2. Invalidar el cache en memoria para esta línea
 *   3. Si se encontró un nuevo proxy, llamar a applyProxyToEvolution para
 *      configurar la instancia Evolution con el nuevo proxy
 *
 * @returns ProxyConfig del nuevo proxy, o null si no hay proxies disponibles
 */
export async function rotateProxyForLine(lineId: string): Promise<ProxyConfig | null> {
  // Obtener el evolution_instance y evolution_url de la línea para el paso 3
  const lineRows = await query<{
    evolution_instance: string
    evolution_url:      string
  }>(
    'SELECT evolution_instance, evolution_url FROM whatsapp_lines WHERE id = $1',
    [lineId]
  )
  const line = lineRows[0]

  // Delegar a distributor (selección + DB write + audit log)
  const result = await distributorRotateProxy({
    lineId,
    assignmentType: 'rotation',
  })

  // Invalidar cache inmediatamente
  proxyCache.delete(lineId)

  if (!result.proxy) {
    console.warn(`[proxy-manager] rotación para ${lineId}: sin proxies disponibles`)
    return null
  }

  const config = rowToConfig(result.proxy as Parameters<typeof rowToConfig>[0])
  proxyCache.set(lineId, { config, fetchedAt: Date.now() })

  // Aplicar nuevo proxy en la instancia Evolution (si hay datos de línea)
  if (line) {
    await applyProxyToEvolution({
      evolutionUrl:  line.evolution_url,
      instanceName:  line.evolution_instance,
      proxy:         config,
    }).catch(e =>
      console.warn(
        `[proxy-manager] no se pudo aplicar proxy a Evolution para ${lineId}:`,
        e instanceof Error ? e.message : e
      )
    )
  }

  console.log(
    `[proxy-manager] línea ${lineId} → proxy rotado a ` +
    `${config.label} (${config.proxyType}, ${config.country ?? 'unknown'})`
  )

  return config
}

// ── applyProxyToEvolution ──────────────────────────────────────────────────────

/**
 * Configura el proxy directamente en la instancia Evolution API.
 *
 * Evolution API v2 soporta proxy por instancia vía:
 *   PUT {evolutionUrl}/instance/update/{instanceName}
 *
 * Este es el paso crítico que hace que el proxy sea REAL:
 * sin esto, el proceso Baileys (WhatsApp Web) de esa instancia
 * sigue saliendo por la IP directa del servidor.
 *
 * Si el endpoint retorna 404 o 405, significa que tu versión de
 * Evolution API no soporta esta feature. Ver "Arquitectura alternativa"
 * al final del archivo.
 *
 * @param evolutionUrl   URL base de la instancia Evolution (ej: http://evo:8080)
 * @param instanceName   Nombre de la instancia (ej: "linea-001")
 * @param proxy          ProxyConfig a aplicar. Si es null, elimina la config de proxy.
 */
export async function applyProxyToEvolution(params: {
  evolutionUrl:  string
  instanceName:  string
  proxy:         ProxyConfig | null
}): Promise<void> {
  const { evolutionUrl, instanceName, proxy } = params

  const apiKey = process.env.EVOLUTION_API_KEY
  if (!apiKey) throw new Error('EVOLUTION_API_KEY not set')

  const body = proxy
    ? {
        proxyHost:     proxy.host,
        proxyPort:     String(proxy.port),
        proxyProtocol: proxy.protocol,
        ...(proxy.username ? { proxyUsername: proxy.username } : {}),
        ...(proxy.password ? { proxyPassword: proxy.password } : {}),
      }
    : {
        // Enviar strings vacíos elimina la config de proxy en Evolution v2
        proxyHost:     '',
        proxyPort:     '',
        proxyProtocol: '',
      }

  const res = await fetch(
    `${evolutionUrl}/instance/update/${instanceName}`,
    {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000),
    }
  )

  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status))
    throw new Error(`Evolution update proxy ${res.status}: ${text}`)
  }

  if (proxy) {
    console.log(
      `[proxy-manager] Evolution instance "${instanceName}" ` +
      `→ proxy configurado: ${proxy.protocol}://${proxy.host}:${proxy.port} ` +
      `(${proxy.proxyType})`
    )
  } else {
    console.log(`[proxy-manager] Evolution instance "${instanceName}" → proxy eliminado`)
  }
}

// ── invalidateProxyCache ───────────────────────────────────────────────────────

/**
 * Invalida el cache de una línea específica.
 * Llamar cuando se rota el proxy manualmente desde la UI.
 */
export function invalidateProxyCache(lineId: string): void {
  proxyCache.delete(lineId)
}

// ── Helpers internos ───────────────────────────────────────────────────────────

/**
 * Devuelve true si el proxy está en cooldown activo.
 * Un proxy en cooldown tuvo < UNHEALTHY_THRESHOLD fallos pero > 0,
 * y el tiempo desde el último fallo es menor a DEGRADED_COOLDOWN_MS.
 */
function isProxyInCooldown(proxyId: string): boolean {
  const entry = tempBlacklist.get(proxyId)
  if (!entry) return false
  if (entry.failureCount >= UNHEALTHY_THRESHOLD) return true  // ya unhealthy en DB
  const elapsed = Date.now() - entry.lastFailAt
  return elapsed < DEGRADED_COOLDOWN_MS
}

/** Lista de proxyIds actualmente en cooldown (para excluirlos de selección). */
function getCooldownProxyIds(): string[] {
  const ids: string[] = []
  for (const [proxyId, entry] of tempBlacklist.entries()) {
    const elapsed = Date.now() - entry.lastFailAt
    if (elapsed < DEGRADED_COOLDOWN_MS) {
      ids.push(proxyId)
    } else {
      // Cooldown expirado — limpiar la entrada
      tempBlacklist.delete(proxyId)
    }
  }
  return ids
}

/** Invalida el cache de todas las líneas que usan un proxy específico. */
async function invalidateCacheByProxyId(proxyId: string): Promise<void> {
  // Buscar en el cache en memoria
  for (const [lineId, entry] of proxyCache.entries()) {
    if (entry.config?.id === proxyId) {
      proxyCache.delete(lineId)
    }
  }
  // También invalidar via DB para capturar líneas cuyo cache ya expiró
  const lineRows = await query<{ id: string }>(
    'SELECT id FROM whatsapp_lines WHERE proxy_id = $1',
    [proxyId]
  ).catch(() => [] as { id: string }[])
  for (const row of lineRows) {
    proxyCache.delete(row.id)
  }
}

// ── Observabilidad ─────────────────────────────────────────────────────────────

/**
 * Estado del blacklist temporal. Útil para dashboards y debugging.
 */
export function getBlacklistStatus(): Array<{
  proxyId:      string
  failureCount: number
  inCooldown:   boolean
  lastReason:   string
  sinceMinutes: number
}> {
  const result = []
  for (const [proxyId, entry] of tempBlacklist.entries()) {
    result.push({
      proxyId,
      failureCount: entry.failureCount,
      inCooldown:   isProxyInCooldown(proxyId),
      lastReason:   entry.lastReason,
      sinceMinutes: Math.round((Date.now() - entry.firstFailAt) / 60_000),
    })
  }
  return result
}

/**
 * Limpia entradas expiradas de la blacklist temporal.
 * Llamar periódicamente (ej: al inicio de cada campaña).
 */
export function flushExpiredBlacklist(): number {
  let removed = 0
  for (const [proxyId, entry] of tempBlacklist.entries()) {
    if (Date.now() - entry.lastFailAt >= DEGRADED_COOLDOWN_MS) {
      tempBlacklist.delete(proxyId)
      removed++
    }
  }
  return removed
}

/*
 * ─── ARQUITECTURA ALTERNATIVA si Evolution API no soporta proxy por instancia ──
 *
 * Opción A — Un contenedor Evolution por grupo de proxies:
 *   - Correr N instancias de Evolution, cada una en un servidor/contenedor
 *     diferente, o detrás de un IP diferente.
 *   - Asignar grupos de líneas a cada instancia de Evolution.
 *   - Cada contenedor Evolution tiene su propia IP de salida (la del servidor).
 *   - Cambiar el proxy implica mover la línea a otro contenedor.
 *   - Complejidad: alta. Beneficio: proxy aplicado a nivel TCP, imposible de evadir.
 *
 * Opción B — Transparent proxy a nivel de red (Docker):
 *   - Usar iptables + redsocks para redirigir el tráfico saliente de cada
 *     contenedor Evolution a través de un proxy SOCKS5.
 *   - Un contenedor proxy-router por cada proxy IP.
 *   - Las líneas asignadas a ese proxy se conectan al contenedor proxy-router.
 *   - No requiere soporte de Evolution API.
 *   - Complejidad: muy alta (infraestructura Docker avanzada).
 *
 * Opción C — Proxy solo para el canal de management (fallback aceptable):
 *   - Si Evolution API no soporta proxy en la instancia, al menos pasar las
 *     llamadas de management (sendText) por el proxy del agente proxy-agent.
 *   - Instalar: npm install https-proxy-agent socks-proxy-agent
 *   - En sendViaEvolution(), crear el agent con la URL del proxy:
 *
 *     import { HttpsProxyAgent } from 'https-proxy-agent'
 *     const agent = proxyConfig ? new HttpsProxyAgent(proxyConfig.url) : undefined
 *     await fetch(url, { ..., dispatcher: agent })  // undici
 *
 *   - IMPORTANTE: esto proxy-ifica la llamada de API (el fetch de Node.js),
 *     pero NO el proceso WhatsApp Web (Baileys) dentro de Evolution.
 *     Para anti-ban de WhatsApp, esto NO es suficiente.
 *     Solo es útil si quieres ocultar la IP del servidor de gestión.
 *
 * ─── RECOMENDACIÓN PARA 2026 ──────────────────────────────────────────────────
 *
 * Configuración recomendada según volumen:
 *
 * < 20 líneas activas:
 *   - 1 proxy residencial por cada 2-3 líneas
 *   - Tipo: residential sticky (un IP por línea, no rotating)
 *   - Proveedor: Smartproxy, Oxylabs Residential, Brightdata
 *   - Rotación: solo si la línea recibe ban; NO rotar preventivamente
 *
 * 20–100 líneas:
 *   - Mobile proxies (4G/5G) para las líneas más activas (top 30%)
 *   - Residential sticky para el resto
 *   - 1 proxy por línea (no compartir entre líneas activas)
 *   - Proveedor mobile: Proxy-Cheap, Airproxy, iProxy.online
 *
 * > 100 líneas:
 *   - Arquitectura multi-contenedor (Opción A arriba)
 *   - ISP proxies para throughput alto (más estables que residential)
 *   - Nunca datacenter para envío de mensajes — solo para healthchecks
 *
 * Tipo > Cantidad:
 *   - 5 proxies mobile de calidad > 20 proxies datacenter
 *   - Un IP limpio que cambia lentamente (mobile/residential sticky) es
 *     mucho más valioso que un datacenter rotativo
 */
