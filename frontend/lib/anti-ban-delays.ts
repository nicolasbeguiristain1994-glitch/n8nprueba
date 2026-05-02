/**
 * anti-ban-delays.ts (v2 - Mejorada)
 *
 * Sistema de delays humanos para campañas de WhatsApp Marketing.
 *
 * Por qué distribución Log-Normal y no uniforme:
 * - Math.random() produce distribución UNIFORME: todos los valores entre min y max
 *   son igualmente probables. Eso crea un patrón estadístico imposible en humanos.
 * - Los humanos tienen tiempos de reacción y comportamiento con distribución
 *   LOG-NORMAL: asimétrica hacia la derecha, con un pico en valores bajos y una
 *   cola larga. Esto refleja que la mayoría de los mensajes salen "rápido", pero
 *   ocasionalmente uno tarda mucho más.
 * - Esta distribución es la estándar en investigaciones de UX y Human-Computer
 *   Interaction para modelar tiempos de respuesta humana.
 *
 * Por qué comportamiento "bursty":
 * - Las personas no envían mensajes a ritmo constante. Mandan unos pocos rápido,
 *   luego se distraen, toman café, atienden otra cosa. Eso crea "ráfagas" de
 *   actividad seguidas de silencios largos.
 * - WhatsApp analiza patrones de tiempo. Un flujo perfectamente espaciado es
 *   una señal clara de automatización.
 *
 * Por qué ruido gaussiano:
 * - Sin ruido, la misma configuración podría generar la misma secuencia de delays
 *   en diferentes corridas si el seed del RNG fuera predecible.
 * - El ruido pequeño garantiza que nunca haya dos campañas con la misma
 *   "firma temporal", incluso con la misma configuración.
 */

// ── Interfaz de configuración ──────────────────────────────────────────────────

export interface HumanDelayConfig {
  minSeconds: number
  maxSeconds: number
  logNormalMu: number
  logNormalSigma: number
  burstProbability: number
  burstMinSeconds: number
  burstMaxSeconds: number
  gaussianNoiseSigma: number
  campaignId?: string
}

// ── Valores por defecto ────────────────────────────────────────────────────────

export const DEFAULT_HUMAN_DELAY_CONFIG: HumanDelayConfig = {
  minSeconds:         8,
  maxSeconds:         120,
  logNormalMu:        2.9,
  logNormalSigma:     0.55,
  burstProbability:   0.20,
  burstMinSeconds:    1800,
  burstMaxSeconds:    5400,
  gaussianNoiseSigma: 1.5,
}

export const HUMAN_DELAY_PRESETS = {
  conservadora: {
    minSeconds:         15,
    maxSeconds:         300,
    logNormalMu:        3.5,
    logNormalSigma:     0.65,
    burstProbability:   0.25,
    burstMinSeconds:    2700,
    burstMaxSeconds:    7200,
    gaussianNoiseSigma: 2.0,
  } satisfies HumanDelayConfig,

  normal: DEFAULT_HUMAN_DELAY_CONFIG,

  agresiva: {
    minSeconds:         3,
    maxSeconds:         60,
    logNormalMu:        2.2,
    logNormalSigma:     0.45,
    burstProbability:   0.15,
    burstMinSeconds:    1800,
    burstMaxSeconds:    3600,
    gaussianNoiseSigma: 1.0,
  } satisfies HumanDelayConfig,
}

// ── Generadores estadísticos ───────────────────────────────────────────────────

function boxMullerNormal(): number {
  const u1 = Math.max(Number.EPSILON, Math.random())
  const u2 = Math.random()
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
}

function generateLogNormal(mu: number, sigma: number): number {
  return Math.exp(mu + sigma * boxMullerNormal())
}

function gaussianNoise(sigma: number): number {
  return sigma * boxMullerNormal()
}

// ── Función principal ──────────────────────────────────────────────────────────

export async function humanLikeDelay(
  config: HumanDelayConfig,
  signal?: AbortSignal,
): Promise<void> {
  const tag = config.campaignId
    ? `[humanLikeDelay ${config.campaignId}]`
    : '[humanLikeDelay]'

  let delaySeconds: number

  // 1. Pausa larga (bursty)
  if (Math.random() < config.burstProbability) {
    const burstRange = config.burstMaxSeconds - config.burstMinSeconds
    delaySeconds = config.burstMinSeconds + Math.random() * burstRange

    const minutes = (delaySeconds / 60).toFixed(1)
    console.log(`${tag} ⏸  PAUSA LARGA activada: ${minutes} min (burst mode)`)

  } else {
    // 2. Delay Log-Normal
    const rawLogNormal = generateLogNormal(config.logNormalMu, config.logNormalSigma)

    delaySeconds = Math.min(
      Math.max(rawLogNormal, config.minSeconds),
      config.maxSeconds
    )

    // 3. Ruido gaussiano + re-clamp (MEJORA v2)
    const noise = gaussianNoise(config.gaussianNoiseSigma)
    delaySeconds = delaySeconds + noise

    // Re-clamp después del ruido para mantener límites estrictos
    delaySeconds = Math.min(
      Math.max(delaySeconds, config.minSeconds),
      config.maxSeconds
    )
  }

  // 4. Mínimo absoluto de seguridad
  delaySeconds = Math.max(3, delaySeconds)

  const delayMs = Math.round(delaySeconds * 1000)

  if (delaySeconds < config.burstMinSeconds) {
    console.log(`${tag} ⏱  delay normal: ${delaySeconds.toFixed(1)} seg`)
  }

  return new Promise((resolve, reject) => {
    // Verificar si ya fue abortado antes de crear el timer
    if (signal?.aborted) {
      reject(new DOMException('Delay aborted', 'AbortError'))
      return
    }

    const timer = setTimeout(resolve, delayMs)

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Delay aborted', 'AbortError'))
      }, { once: true })
    }
  })
}

// ── Factory mejorado (v2) ──────────────────────────────────────────────────────

export function buildDelayConfig(campaign: {
  antiblock_delay_min: number
  antiblock_delay_max: number
  id?: string
}): HumanDelayConfig {
  const base = DEFAULT_HUMAN_DELAY_CONFIG

  // MEJORA v2: Ajuste suave del mu en lugar de sobrescribirlo completamente
  const mid = (campaign.antiblock_delay_min + campaign.antiblock_delay_max) / 2
  const muAdjustment = mid > 0 ? Math.log(Math.max(1, mid)) - base.logNormalMu : 0
  const adjustedMu = base.logNormalMu + Math.max(-0.4, Math.min(0.4, muAdjustment))

  return {
    ...base,
    minSeconds:  Math.max(3, campaign.antiblock_delay_min),
    maxSeconds:  campaign.antiblock_delay_max,
    logNormalMu: adjustedMu,
    campaignId:  campaign.id,
  }
}
