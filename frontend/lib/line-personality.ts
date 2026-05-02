/**
 * line-personality.ts (v2)
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
 * Diseño de persistencia:
 *   El store es un Map en memoria (zero-latency, sin round-trip a DB).
 *   loadPersonalityFromDB / savePersonalityToDB sincronizan con whatsapp_lines
 *   (columna personality_config JSONB sugerida) sin cambiar la API pública.
 */

import {
  HumanDelayConfig,
  DEFAULT_HUMAN_DELAY_CONFIG,
  HUMAN_DELAY_PRESETS,
} from '@/lib/anti-ban-delays'

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

// ── createLinePersonality ──────────────────────────────────────────────────────

/**
 * Crea una personalidad única para una línea a partir de un perfil base.
 *
 * Aplica:
 *   - Jitter en activeHours (±30–90 min) con validación de ventana mínima
 *   - Variación de ±8% en aggressiveness
 *   - Variación de ±0.02 en burstiness
 *
 * @param lineId             ID de la línea (whatsapp_lines.id)
 * @param profileType        Perfil base. Default: 'normal'
 * @param timezoneOverride   Si se pasa, sobrescribe el timezoneOffsetHours del perfil.
 *                           Útil para operar en múltiples mercados desde el mismo código.
 */
export function createLinePersonality(
  lineId:            string,
  profileType:       ProfileType = 'normal',
  timezoneOverride?: number,
): LinePersonality {
  const base = DEFAULT_PROFILES[profileType]

  // Jitter en los límites del horario activo (±30–90 min) + ventana mínima 2h
  const [rawStart, rawEnd] = base.activeHours
  const [jitteredStart, jitteredEnd] = enforceMinWindow(
    applyHourJitter(rawStart),
    applyHourJitter(rawEnd),
  )
  const activeHours: [number, number] = [jitteredStart, jitteredEnd]

  // Variación en aggressiveness (±8%)
  const aggJitter      = 1 + (Math.random() * 0.16 - 0.08)
  const aggressiveness = Math.min(1.4, Math.max(0.6, base.aggressiveness * aggJitter))

  // Variación en burstiness (±0.02)
  const burstJitter = Math.random() * 0.04 - 0.02
  const burstiness  = Math.min(0.28, Math.max(0.12, base.burstiness + burstJitter))

  const personality: LinePersonality = {
    id:                  lineId,
    activeHours,
    aggressiveness,
    burstiness,
    preferredDelayPreset: base.preferredDelayPreset,
    sleepProbability:    base.sleepProbability,
    lastActiveAt:        new Date(),
    profileType,
    timezoneOffsetHours: timezoneOverride ?? base.timezoneOffsetHours,
  }

  personalityStore.set(lineId, personality)
  return personality
}

// ── getLinePersonality ─────────────────────────────────────────────────────────

/**
 * Devuelve la personalidad de una línea desde el store.
 * Si no existe, crea una nueva con el perfil 'normal' (fallback de emergencia).
 *
 * En producción: llamar loadPersonalityFromDB() al iniciar el procesador
 * para hidratar el store antes de que este fallback se active.
 */
export function getLinePersonality(lineId: string): LinePersonality {
  const existing = personalityStore.get(lineId)
  if (existing) return existing

  console.warn(`[personality] línea ${lineId} sin personalidad registrada — asignando 'normal'`)
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
      `ventana: ${start.toFixed(1)}–${end.toFixed(1)}`
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
      `inactiva ${hoursInactive}h)`
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
 *   - logNormalSigma y gaussianNoiseSigma ← del preset preferido de la línea
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
  }
}

// ── updateLastActiveAt ─────────────────────────────────────────────────────────

/**
 * Registra actividad exitosa en la línea.
 *
 * Efectos:
 *   1. Actualiza lastActiveAt → el inertiaBoost vuelve a 0 en la próxima evaluación
 *   2. Limpia la entrada del sleepDecisionCache → la próxima evaluación recalcula
 *      la decisión de sueño con el lastActiveAt actualizado (la línea "despertó")
 *
 * Llamar después de cada sendViaEvolution exitoso.
 */
export function updateLastActiveAt(lineId: string): void {
  const p = personalityStore.get(lineId)
  if (!p) return

  personalityStore.set(lineId, { ...p, lastActiveAt: new Date() })

  // Limpiar la decisión de sueño cacheada: el envío exitoso demuestra que
  // la línea está activa → la próxima evaluación debe recalcular sin el
  // cache previo que pudo haber sido tomado con alta inercia.
  sleepDecisionCache.delete(lineId)
}

// ── Persistencia DB ────────────────────────────────────────────────────────────

/**
 * Carga la personalidad de una línea desde un registro JSONB de la DB.
 *
 * Si el registro no existe o está incompleto, crea una nueva personalidad
 * con el defaultProfile especificado.
 *
 * Columna DB sugerida: whatsapp_lines.personality_config JSONB
 *
 * @param lineId         ID de la línea
 * @param dbRecord       Valor de personality_config, o null/undefined si no existe
 * @param defaultProfile Perfil a usar si no hay registro en DB
 */
/**
 * Valida que activeHours sea un array de exactamente 2 enteros en [0, 24).
 * Rechaza valores como null, [null, null], [99, -5] que pasarían la guardia anterior.
 */
function isValidActiveHours(val: unknown): val is [number, number] {
  return (
    Array.isArray(val) &&
    val.length === 2 &&
    typeof val[0] === 'number' && Number.isFinite(val[0]) && val[0] >= 0 && val[0] < 24 &&
    typeof val[1] === 'number' && Number.isFinite(val[1]) && val[1] >= 0 && val[1] < 24
  )
}

export function loadPersonalityFromDB(
  lineId:         string,
  dbRecord:       Partial<LinePersonality> | null | undefined,
  defaultProfile: ProfileType = 'normal',
): LinePersonality {
  if (
    dbRecord &&
    isValidActiveHours(dbRecord.activeHours) &&
    typeof dbRecord.aggressiveness === 'number' &&
    Number.isFinite(dbRecord.aggressiveness)
  ) {
    const hydrated: LinePersonality = {
      id:                  lineId,
      activeHours:         dbRecord.activeHours as [number, number],
      aggressiveness:      dbRecord.aggressiveness,
      burstiness:          dbRecord.burstiness          ?? DEFAULT_PROFILES[defaultProfile].burstiness,
      preferredDelayPreset: dbRecord.preferredDelayPreset ?? DEFAULT_PROFILES[defaultProfile].preferredDelayPreset,
      sleepProbability:    dbRecord.sleepProbability    ?? DEFAULT_PROFILES[defaultProfile].sleepProbability,
      lastActiveAt:        dbRecord.lastActiveAt ? new Date(dbRecord.lastActiveAt as unknown as string) : new Date(),
      profileType:         dbRecord.profileType         ?? defaultProfile,
      timezoneOffsetHours: dbRecord.timezoneOffsetHours ?? DEFAULT_PROFILES[defaultProfile].timezoneOffsetHours,
    }
    personalityStore.set(lineId, hydrated)
    return hydrated
  }

  console.log(`[personality] línea ${lineId} sin registro en DB — creando perfil '${defaultProfile}'`)
  return createLinePersonality(lineId, defaultProfile)
}

/**
 * Serializa la personalidad de una línea para almacenar en columna JSONB.
 *
 * Ejemplo de uso:
 *   await query(
 *     'UPDATE whatsapp_lines SET personality_config = $1 WHERE id = $2',
 *     [JSON.stringify(savePersonalityToDB(lineId)), lineId]
 *   )
 */
export function savePersonalityToDB(lineId: string): Partial<LinePersonality> | null {
  const p = personalityStore.get(lineId)
  if (!p) return null
  return {
    activeHours:          p.activeHours,
    aggressiveness:       p.aggressiveness,
    burstiness:           p.burstiness,
    preferredDelayPreset: p.preferredDelayPreset,
    sleepProbability:     p.sleepProbability,
    lastActiveAt:         p.lastActiveAt,
    profileType:          p.profileType,
    timezoneOffsetHours:  p.timezoneOffsetHours,
  }
}

/**
 * Elimina la personalidad de una línea del store y del cache de decisión.
 * Llamar cuando la línea se desconecta o se elimina del sistema.
 */
export function evictPersonality(lineId: string): void {
  personalityStore.delete(lineId)
  // FIX v2: limpiar también el sleep cache para no dejar entradas huérfanas
  sleepDecisionCache.delete(lineId)
}

/** Cuántas personalidades hay cargadas. Útil para monitoreo. */
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
