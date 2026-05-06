/**
 * anti-ban-delays.ts (v3.1)
 *
 * Sistema de delays humanos para campañas de WhatsApp Marketing.
 *
 * ── Fundamento estadístico ────────────────────────────────────────────────────
 *
 * Log-Normal como distribución base
 *   Los tiempos de respuesta humana son asimétricos hacia la derecha: la mayoría
 *   de los mensajes salen rápido, con una cola larga ocasional. Esta forma es
 *   el estándar en investigaciones HCI y es imposible de replicar con
 *   Math.random() (distribución uniforme), que WhatsApp puede detectar
 *   trivialmente con un test de uniformidad sobre los intervalos.
 *
 * Rejection sampling en lugar de doble-clamp (fix v2)
 *   El patrón v2 (clamp → ruido → re-clamp) acumula masa de probabilidad en los
 *   extremos minSeconds y maxSeconds, creando picos artificiales en la
 *   distribución. Rejection sampling descarta muestras fuera de [min, max] y
 *   regenera, preservando la forma de la distribución truncada sin distorsión.
 *
 * Burst mode con Log-Normal (no uniforme)
 *   Math.random() produce pausas "demasiado uniformes" en el tiempo. El
 *   comportamiento real es que la mayoría de las pausas largas se concentran
 *   alrededor de un valor típico, con algunas outliers más largas. Log-Normal
 *   (con σ≈0.35) modela esta concentración con cola derecha natural.
 *
 * Micro-jitter intra-mensaje
 *   Delay adicional de baja latencia (200-800ms por defecto) aplicado tras cada
 *   mensaje para simular la variabilidad del tipeo humano: el tiempo entre que
 *   el usuario termina de pensar y presiona enviar. También Log-Normal para
 *   evitar uniformidad detectable.
 *
 * ── Variable de entorno ───────────────────────────────────────────────────────
 *   DELAY_LOG_LEVEL=debug | info (default) | off
 */

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export interface HumanDelayConfig {
  /** Límite inferior del delay normal (seg). */
  minSeconds: number
  /** Límite superior del delay normal (seg). */
  maxSeconds: number
  /** Parámetro μ de la distribución Log-Normal base. */
  logNormalMu: number
  /** Parámetro σ de la distribución Log-Normal base. */
  logNormalSigma: number
  /** Probabilidad [0,1] de activar una pausa larga (burst). */
  burstProbability: number
  /** Límite inferior de la pausa burst (seg). */
  burstMinSeconds: number
  /** Límite superior de la pausa burst (seg). */
  burstMaxSeconds: number
  /** σ del ruido gaussiano aditivo (seg). Aplicado via rejection sampling. */
  gaussianNoiseSigma: number
  /** Rango del micro-jitter post-mensaje (ms). */
  microJitterMs: { min: number; max: number }
  /** ID de campaña — aparece en los logs para correlación. */
  campaignId?: string
}

// ── Valores por defecto ────────────────────────────────────────────────────────

export const DEFAULT_HUMAN_DELAY_CONFIG: HumanDelayConfig = {
  minSeconds:         8,
  maxSeconds:         120,
  logNormalMu:        2.9,      // mediana ≈ 18s
  logNormalSigma:     0.55,
  burstProbability:   0.20,
  burstMinSeconds:    1800,     // 30 min
  burstMaxSeconds:    5400,     // 90 min
  gaussianNoiseSigma: 1.5,
  microJitterMs:      { min: 200, max: 800 },
}

export const HUMAN_DELAY_PRESETS = {
  conservadora: {
    minSeconds:         15,
    maxSeconds:         300,
    logNormalMu:        3.5,    // mediana ≈ 33s
    logNormalSigma:     0.65,
    burstProbability:   0.25,
    burstMinSeconds:    2700,   // 45 min
    burstMaxSeconds:    7200,   // 2 h
    gaussianNoiseSigma: 2.0,
    microJitterMs:      { min: 300, max: 1200 },
  } satisfies HumanDelayConfig,

  normal: DEFAULT_HUMAN_DELAY_CONFIG,

  agresiva: {
    minSeconds:         3,
    maxSeconds:         60,
    logNormalMu:        2.2,    // mediana ≈ 9s
    logNormalSigma:     0.45,
    burstProbability:   0.15,
    burstMinSeconds:    1800,   // 30 min
    burstMaxSeconds:    3600,   // 60 min
    gaussianNoiseSigma: 1.0,
    microJitterMs:      { min: 100, max: 400 },
  } satisfies HumanDelayConfig,
}

// ── PRNG ───────────────────────────────────────────────────────────────────────

/**
 * Box-Muller transform: genera N(0,1) a partir de dos uniformes independientes.
 * El clamp de u1 aleja el 0 del logaritmo para evitar -Infinity.
 */
function standardNormal(): number {
  const u1 = Math.max(Number.EPSILON, Math.random())
  const u2 = Math.random()
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
}

/**
 * Muestrea de una distribución Log-Normal truncada al intervalo [lo, hi]
 * mediante rejection sampling con soft fallback.
 *
 * Algoritmo:
 *   X = exp(μ + σ·Z₁) + noiseσ·Z₂   donde Z₁,Z₂ ~ N(0,1)
 *   Si X ∈ [lo, hi] → acepta. Si no → descarta y reintenta.
 *   Tras maxRetries intentos sin éxito → soft fallback (ver abajo).
 *
 * ── ¿Por qué rejection sampling y no doble-clamp? ────────────────────────────
 *   El clamp acumula masa de probabilidad en los extremos (lo y hi), creando
 *   picos artificiales que son estadísticamente imposibles en humanos y
 *   detectables con un simple histograma de intervalos.
 *   Rejection sampling descarta los outliers y preserva la forma interior de
 *   la distribución sin distorsión.
 *
 * ── Tradeoff: tasa de rechazo vs naturalidad ─────────────────────────────────
 *   Con los parámetros típicos (σ≈0.55, noiseσ≈1.5, rango [8,120]s) la tasa
 *   de aceptación por intento es ~88-93%. Con 25 intentos, la probabilidad de
 *   agotar todos es < (0.12)^25 ≈ 10⁻²³ — prácticamente imposible.
 *   Si σ o noiseσ fueran desproporcionadamente grandes respecto al rango
 *   (misconfiguration), la tasa de aceptación podría caer. Por eso el
 *   maxRetries es una red de seguridad para ese escenario excepcional.
 *   25 retries es suficiente para cualquier configuración razonable y evita
 *   loops de larga duración si alguien configura parámetros extremos.
 *
 * ── Soft fallback (v3.1) ──────────────────────────────────────────────────────
 *   En lugar del clamp duro del v3, tomamos el último candidato generado,
 *   lo proyectamos a [lo, hi], y le sumamos ruido gaussiano multiplicativo
 *   de ±5%. Esto produce un valor cerca del borde con varianza natural —
 *   mucho menos detectable que un spike en el límite exacto.
 *
 * @param mu         - Parámetro μ de la log-normal.
 * @param sigma      - Parámetro σ de la log-normal.
 * @param lo         - Límite inferior (inclusive).
 * @param hi         - Límite superior (inclusive).
 * @param noiseSigma - σ del ruido gaussiano aditivo (0 = sin ruido).
 * @param maxRetries - Intentos antes del soft fallback (default: 25).
 */
function sampleBounded(
  mu:         number,
  sigma:      number,
  lo:         number,
  hi:         number,
  noiseSigma  = 0,
  maxRetries  = 25,
): number {
  let lastCandidate = (lo + hi) / 2  // valor inicial seguro si el loop no itera

  for (let i = 0; i < maxRetries; i++) {
    const logNormal   = Math.exp(mu + sigma * standardNormal())
    const sample      = noiseSigma > 0 ? logNormal + noiseSigma * standardNormal() : logNormal
    lastCandidate     = sample
    if (sample >= lo && sample <= hi) return sample
  }

  // Soft fallback: proyectar al rango + ruido multiplicativo ±5%.
  // Más natural que el clamp duro: en lugar de un spike en lo/hi, produce
  // una distribución suave cerca del borde más cercano.
  const clamped  = Math.max(lo, Math.min(hi, lastCandidate))
  const softened = clamped + clamped * 0.05 * standardNormal()
  return Math.max(lo, Math.min(hi, softened))
}

/**
 * Muestrea un delay de pausa larga (burst) usando Log-Normal.
 *
 * Deriva μ tal que la moda de la distribución coincida con la media geométrica
 * de [minSec, maxSec]:
 *   moda = exp(μ − σ²)  =>  μ = log(geoMean) + σ²
 *
 * Con σ=0.35, el 95% de las muestras se concentra en un rango ~3x alrededor
 * de la moda, mucho más realista que la distribución uniforme del v2.
 */
function sampleBurstDelay(minSec: number, maxSec: number): number {
  const BURST_SIGMA = 0.35
  const geoMean     = Math.sqrt(minSec * maxSec)
  const mu          = Math.log(geoMean) + BURST_SIGMA * BURST_SIGMA
  return sampleBounded(mu, BURST_SIGMA, minSec, maxSec, 0, 50)
}

/**
 * Muestrea el micro-jitter intra-mensaje (en ms) usando Log-Normal.
 *
 * Misma lógica de derivación de μ que sampleBurstDelay: moda ≈ media geométrica
 * del rango. Con σ=0.30, produce valores bien concentrados y con cola suave.
 */
function sampleMicroJitter(cfg: { min: number; max: number }): number {
  if (cfg.min >= cfg.max) return cfg.min
  const JITTER_SIGMA = 0.30
  const geoMean      = Math.sqrt(cfg.min * cfg.max)
  const mu           = Math.log(geoMean) + JITTER_SIGMA * JITTER_SIGMA
  return sampleBounded(mu, JITTER_SIGMA, cfg.min, cfg.max, 0, 30)
}

// ── Logging ────────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'off'

const RESOLVED_LOG_LEVEL: LogLevel =
  (process.env.DELAY_LOG_LEVEL as LogLevel | undefined) ?? 'info'

function log(level: 'debug' | 'info', tag: string, msg: string): void {
  if (RESOLVED_LOG_LEVEL === 'off') return
  if (level === 'debug' && RESOLVED_LOG_LEVEL !== 'debug') return
  console.log(`${tag} [${level}] ${msg}`)
}

// ── Sleep helper ───────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Delay aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Delay aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

// ── Función principal ──────────────────────────────────────────────────────────

/**
 * Espera un tiempo humano-verosímil antes de enviar el siguiente mensaje.
 *
 * Flujo:
 *   1. Con probabilidad burstProbability: pausa larga Log-Normal en
 *      [burstMinSeconds, burstMaxSeconds].
 *   2. Si no: delay Log-Normal + ruido gaussiano via rejection sampling en
 *      [minSeconds, maxSeconds]. Sin doble-clamp.
 *   3. Siempre: micro-jitter Log-Normal en microJitterMs para simular tipeo.
 *
 * @throws DOMException('AbortError') si el AbortSignal se activa durante la espera.
 */
export async function humanLikeDelay(
  config: HumanDelayConfig,
  signal?: AbortSignal,
): Promise<void> {
  const tag = config.campaignId ? `[delay:${config.campaignId}]` : '[delay]'

  // ── 1. Calcular delay principal ────────────────────────────────────────────

  let delaySeconds: number

  if (Math.random() < config.burstProbability) {
    delaySeconds = sampleBurstDelay(config.burstMinSeconds, config.burstMaxSeconds)
    log('info', tag, `PAUSA LARGA: ${(delaySeconds / 60).toFixed(1)} min (burst)`)
  } else {
    delaySeconds = sampleBounded(
      config.logNormalMu,
      config.logNormalSigma,
      config.minSeconds,
      config.maxSeconds,
      config.gaussianNoiseSigma,
    )
    log('info',  tag, `delay: ${delaySeconds.toFixed(1)}s`)
    log('debug', tag, `rejection-sampled — μ=${config.logNormalMu} σ=${config.logNormalSigma} noiseσ=${config.gaussianNoiseSigma} bounds=[${config.minSeconds},${config.maxSeconds}]`)
  }

  // Mínimo absoluto de seguridad — nunca menos de 3 segundos
  delaySeconds = Math.max(3, delaySeconds)

  // ── 2. Esperar delay principal ─────────────────────────────────────────────

  await sleep(Math.round(delaySeconds * 1000), signal)

  // ── 3. Micro-jitter intra-mensaje ──────────────────────────────────────────

  const jitterMs = Math.round(sampleMicroJitter(config.microJitterMs))
  log('info',  tag, `⏱ micro-jitter: +${jitterMs}ms`)
  log('debug', tag, `jitter bounds=[${config.microJitterMs.min},${config.microJitterMs.max}]ms`)
  await sleep(jitterMs, signal)
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Construye un HumanDelayConfig a partir de los parámetros de campaña.
 *
 * Ajusta μ suavemente (máx ±0.4) para que la mediana de la distribución se
 * aproxime al punto medio del rango configurado por el usuario, manteniendo
 * la forma general de la distribución por defecto.
 */
export function buildDelayConfig(campaign: {
  antiblock_delay_min: number
  antiblock_delay_max: number
  id?: string
}): HumanDelayConfig {
  const base = DEFAULT_HUMAN_DELAY_CONFIG
  const mid  = (campaign.antiblock_delay_min + campaign.antiblock_delay_max) / 2

  // Ajuste de μ proporcional a la diferencia entre log(mid) y el μ base
  const muDelta   = mid > 0 ? Math.log(Math.max(1, mid)) - base.logNormalMu : 0
  const adjustedMu = base.logNormalMu + Math.max(-0.4, Math.min(0.4, muDelta))

  return {
    ...base,
    minSeconds:  Math.max(3, campaign.antiblock_delay_min),
    maxSeconds:  campaign.antiblock_delay_max,
    logNormalMu: adjustedMu,
    campaignId:  campaign.id,
  }
}
