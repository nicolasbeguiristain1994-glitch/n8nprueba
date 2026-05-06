/**
 * line-personality.ts (v3)
 *
 * Sistema de Personalidad por Línea para WhatsApp Marketing anti-ban.
 *
 * Problema que resuelve:
 *   Si todas las líneas envían con el mismo patrón de timing, WhatsApp puede
 *   detectar correlación entre cuentas y aplicar bans en bloque (cluster ban).
 *   Asignar una "personalidad" única a cada número hace que cada línea parezca
 *   un usuario humano diferente, con sus propios hábitos y horarios.
 *
 * Cambios v2 respecto a v1:
 *   - FIX: distFromEnd corregido para rangos que cruzan medianoche (nightOwl)
 *   - FIX: nowHour usa una sola instancia de Date (eliminada race condition)
 *   - NEW: timezoneOffsetHours por línea (ej: Argentina = -3)
 *   - NEW: sleepDecisionCache — decisión de dormir estable dentro del mismo bucket horario
 *   - NEW: getInertiaBoost — líneas inactivas muchas horas tienen mayor probabilidad de
 *          seguir dormidas (efecto inercia, más realista)
 *   - NEW: getAdjustedDelayConfig escala también burstMinSeconds/burstMaxSeconds
 *   - FIX: evictPersonality limpia también el sleepDecisionCache
 *
 * Cambios v3 respecto a v2:
 *   - NEW: applyJitterToActiveHours() expuesto como función pública (útil para re-jitter
 *          periódico y para tests)
 *   - NEW: loadPersonalityFromDB(lineId) — async real que consulta whatsapp_lines.personality_config
 *   - NEW: savePersonalityToDB(personality) — async real que persiste en DB
 *   - CHANGE: createLinePersonality() ahora es async — intenta cargar desde DB antes de
 *             crear una nueva, garantizando que el jitter de activeHours sea estable entre
 *             deploys y reinicios del proceso
 *   - CHANGE: getLinePersonality() ahora es async — cadena: store → DB → crear nueva
 *   - CHANGE: updateLastActiveAt() escribe en DB fire-and-forget tras actualizar en memoria
 *   - DOC: evictPersonality() documenta intencionalmente que NO borra de DB
 *
 * Diseño de persistencia:
 *   El store en memoria es el camino rápido (O(1), zero-latency).
 *   La DB actúa como fuente de verdad duradera: garantiza que el jitter de activeHours
 *   de cada número sea idéntico entre deploys. Sin persistencia, cada reinicio
 *   regeneraría ventanas distintas → la "firma temporal" del número cambiaría, lo que
 *   WhatsApp puede detectar como comportamiento anómalo.
 */

import { query } from '@/lib/db'
import {
  HumanDelayConfig,
  DEFAULT_HUMAN_DELAY_CONFIG,
  HUMAN_DELAY_PRESETS,
} from '@/lib/anti-ban-delays'

// ── Versión del esquema de personality_config ─────────────────────────────────
// Incrementar al cambiar la forma del objeto JSONB. hydrateFromRecord puede
// usar este valor para aplicar migraciones de estructura en el futuro.
const PERSONALITY_VERSION = 1

// ── Tipos ──────────────────────────────────────────────────────────────────────

export type DelayPreset = 'conservadora' | 'normal' | 'agresiva'

export type ProfileType =
  | 'conservative'
  | 'normal'
  | 'aggressive'
  | 'nightOwl'
  | 'earlyBird'

export interface LinePersonality {
  /** ID de la línea (whatsapp_lines.id). */
  id: string

  /**
   * Ventana horaria de actividad [inicio, fin] en hora LOCAL de la línea.
   * El offset UTC→local lo aplica timezoneOffsetHours.
   * Ej: [8, 23] = activa de 08:00 a 23:00 hora local.
   * Soporta rangos que cruzan medianoche: [19, 3] = activa de 19:00 a 03:00.
   */
  activeHours: [number, number]

  /**
   * Multiplicador de velocidad de envío (0.6–1.4).
   * < 1.0 → más lento (delays más largos).
   * > 1.0 → más rápido (delays más cortos).
   */
  aggressiveness: number

  /**
   * Probabilidad de pausas largas (bursty). Rango: 0.12–0.28.
   * Sobrescribe burstProbability del preset base en getAdjustedDelayConfig.
   */
  burstiness: number

  /** Preset de delay base antes de aplicar ajustes de personalidad. */
  preferredDelayPreset: DelayPreset

  /**
   * Probabilidad de "dormir" en horario marginal (primera/última hora de la ventana).
   * La decisión se toma una vez por bucket horario y se mantiene estable
   * durante toda esa hora (ver sleepDecisionCache).
   */
  sleepProbability: number

  /** Timestamp de última actividad exitosa. Usado para calcular inercia. */
  lastActiveAt: Date

  /** Tipo de perfil del que se derivó esta personalidad (informativo). */
  profileType: ProfileType

  /**
   * Offset UTC→local en horas para esta línea.
   * Argentina = -3, España = +1, México CDMX = -6, etc.
   * Se usa para que activeHours se evalúe en hora local del operador,
   * no en UTC (que haría que earlyBird [5,15] fuera activo de 2AM a 12PM en ARG).
   */
  timezoneOffsetHours: number
}

// ── Perfiles base ──────────────────────────────────────────────────────────────

/**
 * Arquetipos de comportamiento. createLinePersonality() parte de uno y aplica
 * jitter para que cada instancia sea única incluso dentro del mismo perfil.
 *
 * timezoneOffsetHours = -3 (Argentina) como default operativo.
 * Sobreescribir en createLinePersonality() para otros mercados.
 */
export const DEFAULT_PROFILES: Record<ProfileType, Omit<LinePersonality, 'id' | 'lastActiveAt'>> = {
  /**
   * conservative — números nuevos o con historial de ban.
   * Horario de oficina, muy lento, muchas pausas largas.
   */
  conservative: {
    activeHours:          [9, 20],
    aggressiveness:       0.70,
    burstiness:           0.26,
    preferredDelayPreset: 'conservadora',
    sleepProbability:     0.40,
    profileType:          'conservative',
    timezoneOffsetHours:  -3,
  },

  /**
   * normal — líneas con 2+ semanas de actividad saludable.
   */
  normal: {
    activeHours:          [8, 22],
    aggressiveness:       1.00,
    burstiness:           0.20,
    preferredDelayPreset: 'normal',
    sleepProbability:     0.20,
    profileType:          'normal',
    timezoneOffsetHours:  -3,
  },

  /**
   * aggressive — líneas maduras con alto reputation score.
   * ⚠️ No usar en números nuevos — alto riesgo de ban.
   */
  aggressive: {
    activeHours:          [7, 23],
    aggressiveness:       1.35,
    burstiness:           0.13,
    preferredDelayPreset: 'agresiva',
    sleepProbability:     0.08,
    profileType:          'aggressive',
    timezoneOffsetHours:  -3,
  },

  /**
   * nightOwl — activo principalmente de noche (19:00–03:00 hora local).
   * Cruza medianoche: el cálculo de distFromEnd está corregido en v2.
   */
  nightOwl: {
    activeHours:          [19, 3],
    aggressiveness:       0.90,
    burstiness:           0.22,
    preferredDelayPreset: 'normal',
    sleepProbability:     0.30,
    profileType:          'nightOwl',
    timezoneOffsetHours:  -3,
  },

  /**
   * earlyBird — activo temprano en la mañana, inactivo en la noche.
   */
  earlyBird: {
    activeHours:          [5, 15],
    aggressiveness:       0.95,
    burstiness:           0.18,
    preferredDelayPreset: 'normal',
    sleepProbability:     0.25,
    profileType:          'earlyBird',
    timezoneOffsetHours:  -3,
  },
}

// ── Stores en memoria ──────────────────────────────────────────────────────────

/** lineId → LinePersonality */
const personalityStore = new Map<string, LinePersonality>()

/**
 * Caché de decisión de sueño: lineId → { hourBucket, decision }.
 *
 * Por qué existe:
 *   Sin este caché, la misma línea podría enviar un mensaje, luego ser evaluada
 *   otra vez en el mismo minuto y "decidir" dormirse, creando un comportamiento
 *   errático dentro de la misma hora. Los humanos no toman esa decisión en cada
 *   mensaje — se "van" o "quedan" por períodos coherentes.
 *
 * Ciclo de vida:
 *   - Se escribe en getStableSleepDecision() la primera vez que se evalúa en un
 *     bucket horario nuevo.
 *   - Se limpia en updateLastActiveAt() (al enviar un mensaje exitoso, la línea
 *     "despertó" → la próxima evaluación recalcula con el lastActiveAt actualizado).
 *   - Se limpia en evictPersonality() al desconectar la línea.
 */
const sleepDecisionCache = new Map<string, { hourBucket: number; decision: boolean }>()

// ── Helpers de horario ─────────────────────────────────────────────────────────

/**
 * Aplica jitter aleatorio de ±30–90 minutos a un límite horario.
 * El resultado se envuelve en [0, 24) para mantenerlo en rango válido.
 *
 * Interno: la API pública es applyJitterToActiveHours().
 */
function applyHourJitter(hour: number): number {
  const jitterHours = (0.5 + Math.random() * 1.0) * (Math.random() < 0.5 ? 1 : -1)
  return ((hour + jitterHours) % 24 + 24) % 24
}

/**
 * Garantiza que la ventana activa tenga al menos minWindowHours horas de duración.
 * Si el jitter dejó la ventana demasiado pequeña, expande el límite de cierre.
 *
 * Necesario porque applyHourJitter puede acercar mucho start y end,
 * creando ventanas de minutos en lugar de horas.
 */
function enforceMinWindow(
  start: number,
  end: number,
  minWindowHours = 2,
): [number, number] {
  const windowSize = start <= end
    ? end - start
    : (end + 24 - start)

  if (windowSize >= minWindowHours) return [start, end]

  // Ampliar el cierre manteniendo el inicio fijo
  const newEnd = ((start + minWindowHours) % 24 + 24) % 24
  return [start, newEnd]
}

/**
 * Aplica jitter aleatorio de ±30–90 minutos a ambos límites de activeHours.
 *
 * Diseñado para llamarse UNA SOLA VEZ al crear la personalidad. El jitter debe
 * ser estable en el tiempo: si cada deploy generara ventanas distintas, WhatsApp
 * podría detectar que la "firma horaria" del número cambia sistemáticamente.
 *
 * Uso externo: útil para re-jitterear una personalidad después de un período
 * largo de operación continua (ej: cada 30 días) o en tests unitarios.
 *
 * @param personality Personalidad cuyas activeHours se van a jitterear.
 * @returns Nuevo par [start, end] en [0, 24) con ventana mínima garantizada de 2h.
 */
export function applyJitterToActiveHours(personality: LinePersonality): [number, number] {
  const [rawStart, rawEnd] = personality.activeHours
  return enforceMinWindow(
    applyHourJitter(rawStart),
    applyHourJitter(rawEnd),
  )
}

/**
 * Convierte la hora UTC actual a hora local de la línea aplicando el offset.
 * Devuelve un número decimal: 14.5 = 14:30.
 *
 * @param now                 Instancia única de Date (evitar race condition)
 * @param timezoneOffsetHours UTC offset en horas (Argentina = -3)
 */
function getLocalHour(now: Date, timezoneOffsetHours: number): number {
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60
  return ((utcDecimal + timezoneOffsetHours) % 24 + 24) % 24
}

// ── Inercia y decisión estable de sueño ───────────────────────────────────────

/**
 * Calcula el boost de probabilidad de dormir según inactividad reciente.
 *
 * Efecto inercia: una línea que lleva muchas horas sin enviar tiene más
 * probabilidad de seguir inactiva. Modela el comportamiento humano de
 * "hoy ya no vuelvo a abrir WhatsApp" después de un período largo sin uso.
 *
 * Escala progresiva para evitar un salto brusco:
 *   < 2 horas inactiva →  0% extra (acaba de enviar, está "caliente")
 *   2–4 horas           →  5% extra
 *   4–8 horas           → 15% extra
 *   > 8 horas           → 30% extra (muy probablemente "dormida" para hoy)
 */
// FIX v2: recibe `now` para usar la misma instancia de Date que shouldLineBeActiveNow.
// Antes usaba Date.now() interno, rompiendo el aislamiento temporal intencional.
function getInertiaBoost(personality: LinePersonality, now: Date): number {
  const hoursInactive = (now.getTime() - personality.lastActiveAt.getTime()) / 3_600_000
  if (hoursInactive > 8)  return 0.30
  if (hoursInactive > 4)  return 0.15
  if (hoursInactive > 2)  return 0.05
  return 0
}

/**
 * Devuelve una decisión de sueño estable dentro del mismo bucket horario.
 *
 * La decisión se toma una sola vez por hora y se cachea.
 * Esto evita que una línea alterne activo/dormido dentro del mismo minuto,
 * comportamiento que sería imposible en un humano real.
 *
 * @param lineId      ID de la línea
 * @param hourBucket  Math.floor(localHour) — 0 a 23
 * @param probability Probabilidad efectiva de dormir (base + inertia boost)
 * @returns true = la línea DUERME (no enviar)
 */
function getStableSleepDecision(
  lineId:      string,
  hourBucket:  number,
  probability: number,
): boolean {
  const cached = sleepDecisionCache.get(lineId)

  // Mismo bucket horario → devolver la misma decisión que ya se tomó
  if (cached && cached.hourBucket === hourBucket) {
    return cached.decision
  }

  // Nuevo bucket horario → tomar decisión fresca y cachear
  const decision = Math.random() < probability
  sleepDecisionCache.set(lineId, { hourBucket, decision })
  return decision
}

// ── Persistencia DB ────────────────────────────────────────────────────────────

/**
 * Valida que activeHours sea un array de exactamente 2 números finitos en [0, 24).
 * Rechaza null, arrays de distinto largo, o valores fuera de rango.
 */
function isValidActiveHours(val: unknown): val is [number, number] {
  return (
    Array.isArray(val) &&
    val.length === 2 &&
    typeof val[0] === 'number' && Number.isFinite(val[0]) && val[0] >= 0 && val[0] < 24 &&
    typeof val[1] === 'number' && Number.isFinite(val[1]) && val[1] >= 0 && val[1] < 24
  )
}

/**
 * Hidrata un LinePersonality desde un objeto parcial (registro JSONB de la DB).
 * Rellena campos faltantes con los defaults del profileType correspondiente.
 * Devuelve null si los campos críticos (activeHours, aggressiveness) son inválidos.
 *
 * Solo para uso interno — los callers externos usan loadPersonalityFromDB().
 */
function hydrateFromRecord(
  lineId: string,
  rec:    Partial<LinePersonality>,
): LinePersonality | null {
  if (
    !isValidActiveHours(rec.activeHours) ||
    typeof rec.aggressiveness !== 'number' ||
    !Number.isFinite(rec.aggressiveness)
  ) {
    return null
  }

  const profileType    = (rec.profileType as ProfileType | undefined) ?? 'normal'
  const profileDefault = DEFAULT_PROFILES[profileType] ?? DEFAULT_PROFILES.normal

  const personality: LinePersonality = {
    id:                  lineId,
    activeHours:         rec.activeHours as [number, number],
    aggressiveness:      rec.aggressiveness,
    burstiness:          typeof rec.burstiness      === 'number' ? rec.burstiness      : profileDefault.burstiness,
    preferredDelayPreset: rec.preferredDelayPreset                                      ?? profileDefault.preferredDelayPreset,
    sleepProbability:    typeof rec.sleepProbability === 'number' ? rec.sleepProbability : profileDefault.sleepProbability,
    lastActiveAt:        typeof rec.lastActiveAt === 'string'
                           ? new Date(rec.lastActiveAt as unknown as string)
                           : rec.lastActiveAt instanceof Date ? rec.lastActiveAt : new Date(),
    profileType,
    timezoneOffsetHours: typeof rec.timezoneOffsetHours === 'number'
                           ? rec.timezoneOffsetHours
                           : profileDefault.timezoneOffsetHours,
  }

  personalityStore.set(lineId, personality)
  return personality
}

/**
 * Carga la personalidad de una línea desde whatsapp_lines.personality_config (JSONB).
 *
 * Flujo:
 *   1. Consulta la fila de la línea en la DB.
 *   2. Si personality_config no existe o es inválido → devuelve null.
 *   3. Si es válido → hidrata, guarda en el store en memoria y devuelve.
 *
 * Por qué es crítico para la estrategia anti-ban:
 *   El jitter de activeHours se genera UNA SOLA VEZ al crear la personalidad.
 *   Sin persistencia, cada reinicio del proceso generaría ventanas distintas.
 *   Un número cuyo horario activo cambia sistemáticamente en cada deploy es
 *   una firma detectable por WhatsApp como comportamiento automatizado.
 *
 * @param lineId ID de la línea en whatsapp_lines.
 * @returns LinePersonality si existe registro válido, null si no.
 */
export async function loadPersonalityFromDB(lineId: string): Promise<LinePersonality | null> {
  try {
    const rows = await query<{ personality_config: unknown }>(
      'SELECT personality_config FROM whatsapp_lines WHERE id = $1',
      [lineId],
    )
    const row = rows[0]
    if (!row || row.personality_config === null || row.personality_config === undefined) {
      return null
    }

    const rec = row.personality_config
    if (typeof rec !== 'object' || Array.isArray(rec)) return null

    return hydrateFromRecord(lineId, rec as Partial<LinePersonality>)
  } catch (e) {
    console.warn(
      `[personality] loadPersonalityFromDB error (${lineId}):`,
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

/**
 * Persiste la personalidad de una línea en whatsapp_lines.personality_config.
 *
 * Incluye lastActiveAt (como ISO string) para que tras un reinicio el
 * cálculo de inercia sea correcto desde el primer mensaje.
 *
 * Errores son silenciados como warnings: un fallo de escritura no debe
 * interrumpir el flujo de envío. El estado en memoria sigue siendo correcto.
 *
 * @param personality Personalidad a persistir.
 */
export async function savePersonalityToDB(personality: LinePersonality): Promise<void> {
  try {
    await query(
      `UPDATE whatsapp_lines
       SET personality_config = $1, updated_at = NOW()
       WHERE id = $2`,
      [
        JSON.stringify({
          version:              PERSONALITY_VERSION,
          activeHours:          personality.activeHours,
          aggressiveness:       personality.aggressiveness,
          burstiness:           personality.burstiness,
          preferredDelayPreset: personality.preferredDelayPreset,
          sleepProbability:     personality.sleepProbability,
          lastActiveAt:         personality.lastActiveAt.toISOString(),
          profileType:          personality.profileType,
          timezoneOffsetHours:  personality.timezoneOffsetHours,
        }),
        personality.id,
      ],
    )
  } catch (e) {
    console.warn(
      `⚠️ Failed to persist personality for line ${personality.id}:`,
      e instanceof Error ? e.message : e,
    )
    // Non-critical: el estado en memoria sigue siendo correcto.
    // La próxima llamada a savePersonalityToDB (ej: siguiente createLinePersonality)
    // reintentará la escritura.
  }
}

// ── createLinePersonality ──────────────────────────────────────────────────────

/**
 * Crea (o restaura) una personalidad única para una línea.
 *
 * Flujo v3:
 *   1. Intenta cargar la personalidad desde DB (loadPersonalityFromDB).
 *      Si existe → la devuelve directamente, preservando el jitter original.
 *   2. Si no existe → genera nueva con jitter, guarda en DB, devuelve.
 *
 * Por qué cargar de DB antes de crear:
 *   La personalidad incluye activeHours jitteadas que deben ser ESTABLES entre
 *   deploys. Si se regenerara en cada reinicio, el número mostraría horarios
 *   distintos en cada ejecución — firma detectable.
 *
 * Jitter aplicado al crear:
 *   - activeHours: ±30–90 min en cada límite + ventana mínima 2h
 *   - aggressiveness: ±8%
 *   - burstiness: ±0.02
 *
 * @param lineId             ID de la línea (whatsapp_lines.id)
 * @param profileType        Perfil base. Default: 'normal'
 * @param timezoneOverride   Sobrescribe timezoneOffsetHours del perfil base.
 *                           Útil para operar en múltiples mercados.
 */
export async function createLinePersonality(
  lineId:            string,
  profileType:       ProfileType = 'normal',
  timezoneOverride?: number,
): Promise<LinePersonality> {
  // ── 1. Intentar restaurar desde DB ────────────────────────────────────────
  const fromDB = await loadPersonalityFromDB(lineId)
  if (fromDB) {
    console.log(
      `[personality] línea ${lineId} restaurada desde DB ` +
      `(perfil: ${fromDB.profileType}, ` +
      `ventana: ${fromDB.activeHours[0].toFixed(1)}–${fromDB.activeHours[1].toFixed(1)}h)`,
    )
    return fromDB
  }

  // ── 2. Crear nueva personalidad ───────────────────────────────────────────
  const base = DEFAULT_PROFILES[profileType]

  // Jitter en los límites del horario activo (±30–90 min) + ventana mínima 2h
  const [rawStart, rawEnd] = base.activeHours
  const [jitteredStart, jitteredEnd] = enforceMinWindow(
    applyHourJitter(rawStart),
    applyHourJitter(rawEnd),
  )

  // Variación en aggressiveness (±8%)
  const aggJitter      = 1 + (Math.random() * 0.16 - 0.08)
  const aggressiveness = Math.min(1.4, Math.max(0.6, base.aggressiveness * aggJitter))

  // Variación en burstiness (±0.02)
  const burstJitter = Math.random() * 0.04 - 0.02
  const burstiness  = Math.min(0.28, Math.max(0.12, base.burstiness + burstJitter))

  const personality: LinePersonality = {
    id:                   lineId,
    activeHours:          [jitteredStart, jitteredEnd],
    aggressiveness,
    burstiness,
    preferredDelayPreset: base.preferredDelayPreset,
    sleepProbability:     base.sleepProbability,
    lastActiveAt:         new Date(),
    profileType,
    timezoneOffsetHours:  timezoneOverride ?? base.timezoneOffsetHours,
  }

  personalityStore.set(lineId, personality)

  // ── 3. Persistir en DB (first-write-wins) ────────────────────────────────
  // Usamos WHERE personality_config IS NULL para que solo el primer proceso
  // en llegar escriba su jitter. Si otro proceso ganó la carrera entre nuestro
  // loadPersonalityFromDB y este punto, RETURNING devuelve 0 filas → cargamos
  // la personalidad del ganador en lugar de sobreescribir.
  // Esto garantiza que todos los procesadores concurrentes usen exactamente
  // el mismo jitter para esta línea durante toda su vida útil.
  let savedRows: Array<{ id: string }> = []
  try {
    savedRows = await query<{ id: string }>(
      `UPDATE whatsapp_lines
       SET personality_config = $1, updated_at = NOW()
       WHERE id = $2 AND personality_config IS NULL
       RETURNING id`,
      [
        JSON.stringify({
          version:              PERSONALITY_VERSION,
          activeHours:          personality.activeHours,
          aggressiveness:       personality.aggressiveness,
          burstiness:           personality.burstiness,
          preferredDelayPreset: personality.preferredDelayPreset,
          sleepProbability:     personality.sleepProbability,
          lastActiveAt:         personality.lastActiveAt.toISOString(),
          profileType:          personality.profileType,
          timezoneOffsetHours:  personality.timezoneOffsetHours,
        }),
        lineId,
      ],
    )
  } catch (e) {
    console.warn(
      `⚠️ Failed to persist personality for line ${lineId}:`,
      e instanceof Error ? e.message : e,
    )
    // Error de DB: asumir que ganamos para no hacer una carga extra innecesaria.
  }

  if (savedRows.length === 0) {
    // 0 filas actualizadas → otro proceso ganó la carrera. Usar su personalidad
    // para que todos los procesos concurrentes queden sincronizados.
    const winner = await loadPersonalityFromDB(lineId)
    if (winner) {
      console.log(
        `[personality] línea ${lineId} race condition detectada — ` +
        `adoptando personalidad de proceso concurrente (ventana: ` +
        `${winner.activeHours[0].toFixed(1)}–${winner.activeHours[1].toFixed(1)}h)`,
      )
      return winner
    }
    // Extremadamente raro: el ganador escribió y luego borró personality_config.
    // Mantener la nuestra — el estado en memoria es válido.
  }

  return personality
}

// ── getLinePersonality ─────────────────────────────────────────────────────────

/**
 * Devuelve la personalidad de una línea.
 *
 * Cadena de resolución (en orden de prioridad):
 *   1. Store en memoria → O(1), camino normal durante una campaña activa.
 *   2. createLinePersonality() → intenta DB primero, luego genera nueva.
 *
 * El store se hidrata al primer acceso y queda en memoria para los siguientes.
 * En producción, las personalidades se cargan al iniciar el procesador de campañas
 * mediante llamadas explícitas a createLinePersonality() por cada línea elegible.
 */
export async function getLinePersonality(lineId: string): Promise<LinePersonality> {
  const existing = personalityStore.get(lineId)
  if (existing) return existing

  console.warn(
    `[personality] línea ${lineId} no encontrada en memoria — ` +
    `intentando cargar desde DB o crear nueva con perfil 'normal'`,
  )
  return createLinePersonality(lineId, 'normal')
}

// ── shouldLineBeActiveNow ──────────────────────────────────────────────────────

/**
 * Decide si una línea debe estar activa ahora mismo.
 *
 * Lógica (en orden):
 *   1. Convertir hora UTC → hora local usando timezoneOffsetHours
 *   2. Verificar si estamos dentro de activeHours (soporta rangos cruzamidnoche)
 *   3. Si es horario marginal (primera/última hora de la ventana):
 *      a. Calcular probabilidad efectiva = sleepProbability + inertia boost
 *      b. Tomar/recuperar decisión estable para este bucket horario
 *
 * @returns true = la línea está activa y puede enviar
 *          false = la línea está durmiendo (saltar o esperar)
 */
export function shouldLineBeActiveNow(personality: LinePersonality): boolean {
  // FIX v2: única instancia de Date → elimina race condition si el minuto cambia
  const now     = new Date()
  const nowHour = getLocalHour(now, personality.timezoneOffsetHours)

  const [start, end] = personality.activeHours

  // ── Paso 1: ¿Estamos dentro de la ventana activa? ─────────────────────────
  // Dos casos: rango normal (start < end) y rango que cruza medianoche (start > end).
  let inActiveWindow: boolean
  if (start <= end) {
    inActiveWindow = nowHour >= start && nowHour < end
  } else {
    // nightOwl [19, 3]: activo si hora >= 19 OR hora < 3
    inActiveWindow = nowHour >= start || nowHour < end
  }

  if (!inActiveWindow) {
    console.log(
      `[personality] línea ${personality.id} (${personality.profileType}) ` +
      `fuera de horario — hora local: ${nowHour.toFixed(1)}, ` +
      `ventana: ${start.toFixed(1)}–${end.toFixed(1)}`,
    )
    return false
  }

  // ── Paso 2: ¿Estamos en la zona marginal (primera/última hora)? ───────────

  // Distancia desde el inicio de la ventana activa
  const distFromStart = start <= end
    ? nowHour - start
    : (nowHour >= start ? nowHour - start : nowHour + 24 - start)

  // FIX v2: fórmula correcta para distancia al cierre en rangos cruzamidnoche.
  //
  // Caso normal (start <= end), ej: [8, 22] a las 21:30:
  //   distFromEnd = 22 - 21.5 = 0.5 horas ✓
  //
  // Caso cruzamidnoche (start > end), ej: nightOwl [19, 3]:
  //   a) Si nowHour < end (ej: 01:30): distFromEnd = 3 - 1.5 = 1.5 horas ✓
  //   b) Si nowHour >= start (ej: 22:00): distFromEnd = 3 + 24 - 22 = 5 horas ✓
  //      (incorrecto en v1: daba (22 - 3 + 24) % 24 = 19 horas)
  const distFromEnd = start <= end
    ? end - nowHour
    : (nowHour < end ? end - nowHour : end + 24 - nowHour)

  const inMarginalHour = distFromStart < 1.0 || distFromEnd < 1.0

  if (!inMarginalHour) {
    // En horario central: siempre activa, sin necesidad de evaluar sueño
    return true
  }

  // ── Paso 3: Zona marginal — decisión estable con boost de inercia ─────────
  const inertiaBoost       = getInertiaBoost(personality, now)
  const effectiveSleepProb = Math.min(0.95, personality.sleepProbability + inertiaBoost)
  const hourBucket         = Math.floor(nowHour)

  const shouldSleep = getStableSleepDecision(personality.id, hourBucket, effectiveSleepProb)

  if (shouldSleep) {
    const hoursInactive = ((Date.now() - personality.lastActiveAt.getTime()) / 3_600_000).toFixed(1)
    console.log(
      `[personality] línea ${personality.id} (${personality.profileType}) ` +
      `durmiendo en zona marginal ` +
      `(sleepProb=${personality.sleepProbability} + inercia=${inertiaBoost.toFixed(2)}, ` +
      `inactiva ${hoursInactive}h)`,
    )
    return false
  }

  return true
}

// ── getAdjustedDelayConfig ─────────────────────────────────────────────────────

/**
 * Ajusta un HumanDelayConfig base con la personalidad de la línea.
 *
 * Transformaciones v2:
 *   - minSeconds / maxSeconds  ÷ aggressiveness  (velocidad base)
 *   - burstMinSeconds / burstMaxSeconds  ÷ aggressiveness  (NEW v2: pausas largas también escalan)
 *   - logNormalMu se ajusta logarítmicamente para que la mediana escale con los límites
 *   - burstProbability ← personality.burstiness  (personalidad individual)
 *   - logNormalSigma, gaussianNoiseSigma y microJitterMs ← del preset preferido de la línea
 */
export function getAdjustedDelayConfig(
  baseConfig:  HumanDelayConfig,
  personality: LinePersonality,
): HumanDelayConfig {
  const presetBase = HUMAN_DELAY_PRESETS[personality.preferredDelayPreset] ?? DEFAULT_HUMAN_DELAY_CONFIG

  // Escalar límites de delay normal
  const scaledMin = Math.max(3, baseConfig.minSeconds / personality.aggressiveness)
  const scaledMax = Math.max(scaledMin + 5, baseConfig.maxSeconds / personality.aggressiveness)

  // Ajustar mu para que la mediana log-normal escale con los límites
  // ln(1 / aggressiveness) = -ln(aggressiveness): al aumentar aggressiveness, mu baja
  const muScale    = Math.log(1 / personality.aggressiveness)
  const adjustedMu = Math.max(0.5, baseConfig.logNormalMu + muScale)

  // FIX v2: escalar también las pausas largas (bursty) con aggressiveness.
  // Una línea agresiva (1.4x) tiene pausas largas también más cortas (~28% menos),
  // no solo los delays normales. Mínimo absoluto: 5 min de pausa larga.
  const scaledBurstMin = Math.max(300, baseConfig.burstMinSeconds / personality.aggressiveness)
  const scaledBurstMax = Math.max(scaledBurstMin + 300, baseConfig.burstMaxSeconds / personality.aggressiveness)

  return {
    ...baseConfig,
    minSeconds:         scaledMin,
    maxSeconds:         scaledMax,
    logNormalMu:        adjustedMu,
    logNormalSigma:     presetBase.logNormalSigma,
    burstProbability:   personality.burstiness,
    burstMinSeconds:    scaledBurstMin,
    burstMaxSeconds:    scaledBurstMax,
    gaussianNoiseSigma: presetBase.gaussianNoiseSigma,
    microJitterMs:      presetBase.microJitterMs,
  }
}

// ── updateLastActiveAt ─────────────────────────────────────────────────────────

/**
 * Registra actividad exitosa en la línea.
 *
 * Efectos en memoria (síncronos):
 *   1. Actualiza lastActiveAt → el inertiaBoost vuelve a 0 en la próxima evaluación.
 *   2. Limpia la entrada del sleepDecisionCache → la próxima evaluación recalcula
 *      la decisión de sueño con el lastActiveAt actualizado (la línea "despertó").
 *
 * Efecto en DB (fire-and-forget):
 *   Persiste el nuevo lastActiveAt en personality_config sin bloquear el hot path
 *   de envío. Si el proceso muere entre dos updates, se pierde el lastActiveAt
 *   exacto pero la personalidad estructural (activeHours, aggressiveness, etc.)
 *   queda intacta. El cálculo de inercia al reiniciar partirá del último valor
 *   persistido exitosamente, que es aceptablemente cercano al real.
 *
 * Llamar después de cada sendViaEvolution exitoso.
 */
export function updateLastActiveAt(lineId: string): void {
  const p = personalityStore.get(lineId)
  if (!p) return

  const updated: LinePersonality = { ...p, lastActiveAt: new Date() }
  personalityStore.set(lineId, updated)
  sleepDecisionCache.delete(lineId)

  void savePersonalityToDB(updated).catch(e =>
    console.warn(
      `[personality] updateLastActiveAt DB write failed (${lineId}):`,
      e instanceof Error ? e.message : e,
    )
  )
}

// ── Gestión del store ──────────────────────────────────────────────────────────

/**
 * Elimina la personalidad de una línea del store en memoria y del caché de sueño.
 * Llamar cuando la línea se desconecta o se elimina del sistema.
 *
 * Intencionalmente NO borra de DB:
 *   La fila personality_config en whatsapp_lines persiste para que la próxima
 *   carga de la línea (ej: reconexión) recupere la misma personalidad — con el
 *   mismo jitter de activeHours — en lugar de generar una nueva.
 *   Esto garantiza consistencia temporal entre sesiones y evita que cambios de
 *   horario visibles para WhatsApp coincidan con eventos de reconexión.
 *
 *   Para forzar una personalidad completamente nueva, actualizar directamente
 *   la columna personality_config a NULL en whatsapp_lines y luego llamar
 *   createLinePersonality().
 */
export function evictPersonality(lineId: string): void {
  personalityStore.delete(lineId)
  sleepDecisionCache.delete(lineId)
}

/**
 * Devuelve una personalidad del store en memoria sin ir a DB.
 * Útil en el hot path (ej: filtros síncronos) después de que todas las
 * personalidades ya fueron cargadas en una fase de hidratación previa.
 *
 * Devuelve undefined si la línea no está en memoria — en ese caso usar
 * getLinePersonality() para el fallback completo (DB → crear nueva).
 */
export function getLoadedPersonality(lineId: string): LinePersonality | undefined {
  return personalityStore.get(lineId)
}

/**
 * Hidrata una personalidad desde un registro ya obtenido (ej: batch query).
 * No realiza ninguna consulta a la DB — solo procesa el objeto recibido.
 *
 * Usar cuando el caller ya tiene los datos de personality_config y quiere
 * evitar un round-trip individual por línea (eficiencia en hidratación masiva).
 *
 * @param lineId ID de la línea.
 * @param record Valor de personality_config (puede ser null/undefined si la línea no tiene personalidad).
 * @returns LinePersonality si el record es válido, null si está vacío o mal formado.
 */
export function hydratePersonalityFromRecord(
  lineId: string,
  record: unknown,
): LinePersonality | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  return hydrateFromRecord(lineId, record as Partial<LinePersonality>)
}

/** Cuántas personalidades hay cargadas en memoria. Útil para monitoreo. */
export function getStoreSize(): number {
  return personalityStore.size
}

/**
 * Devuelve los IDs de todas las líneas con personalidad en memoria.
 * Usado por el procesador de campañas para evictar líneas que ya no son elegibles
 * y prevenir crecimiento indefinido del store en procesos de larga vida.
 */
export function getLoadedLineIds(): string[] {
  return [...personalityStore.keys()]
}
