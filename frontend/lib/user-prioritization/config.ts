/**
 * ── Configuración de Priorización para Campañas de Reactivación ──────────────
 *
 * Este archivo es la fuente de verdad para toda la lógica de negocio del módulo.
 * Ver README.md para la documentación completa del modelo.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  GUÍA DE CONFIGURABILIDAD                                               │
 * │                                                                         │
 * │  Los valores marcados [DB-READY] son los mejores candidatos para        │
 * │  moverse a una tabla `priority_score_configs` en v2, permitiendo que    │
 * │  admins los ajusten sin deploy.                                         │
 * │                                                                         │
 * │  Los marcados [CALIBRAR] requieren datos reales de conversión antes     │
 * │  de ajustar — cambiarlos a ciegas puede degradar el ROI.               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

export type ValueTier = 'super_vip' | 'vip' | 'medio' | 'bajo'

export type ReactivationSegment =
  | 'REACTIVACION_URGENTE'          // SUPER_VIP/VIP recién inactivos (7–30d) — prob. retorno alta
  | 'REACTIVACION_PRIORITARIA'      // SUPER_VIP/VIP 31–90d + MEDIO 14–30d — requieren incentivo
  | 'REACTIVACION_ESTANDAR'         // SUPER_VIP/VIP 91–120d + MEDIO 31–60d — oferta especial
  | 'REACTIVACION_FRIA_ALTO_VALOR'  // SUPER_VIP 121–180d + VIP 121–150d — win-back de alto LTV
  | 'REACTIVACION_FRIA'             // BAJO 30–45d — ventana estrecha, ROI marginal

export interface InactivityWindow {
  minDays: number   // Menos de esto → todavía activo, no requiere reactivación
  maxDays: number   // Más de esto → demasiado frío, ROI negativo para el tier
}

export interface SegmentRule {
  segment: ReactivationSegment
  tiers: ValueTier[]
  minDays: number
  maxDays: number
}

// ── Ventanas de inactividad por tier [DB-READY] [CALIBRAR] ───────────────────
//
// Define QUIÉN ENTRA en la lista de difusión.
// Un contacto dentro de la ventana de su tier ES ELEGIBLE y aparece en la lista,
// incluyendo los que están al final de la ventana (urgencyScore = 0).
//
// Regla de diseño:
//   urgencyScore = 0 NO significa "no contactar" — significa "última oportunidad".
//   El score total sigue siendo valueScore + 0, que ordena correctamente:
//   un VIP al final de su ventana (score=60) sigue siendo prioritario sobre
//   un BAJO al inicio de la suya (score=50).
//
// Los tiers VIP/ALTO tienen ventanas más largas porque su LTV > costo del intento
// incluso después de meses de inactividad.
// Los tiers BAJO/MEDIO tienen ventanas cortas: fuera de ese rango, el ROI es negativo.
//
// [CALIBRAR] Ajustar con datos reales de tasa de conversión por tier y franja temporal.
export const INACTIVITY_WINDOWS: Record<ValueTier, InactivityWindow> = {
  super_vip: { minDays: 7,  maxDays: 180 },  // Extendido: Super VIP frío incluye hasta 6 meses
  vip:       { minDays: 7,  maxDays: 150 },  // Extendido: VIP frío hasta 5 meses
  medio:     { minDays: 14, maxDays: 60  },
  bajo:      { minDays: 30, maxDays: 45  },
}

// ── Score de valor base por tier (0–60) [DB-READY] [CALIBRAR] ────────────────
//
// Refleja el LTV relativo de cada tier. Fijo por tier — no cambia con el tiempo.
// Un VIP vale 6× más que un bajo, lo que garantiza que VIP SIEMPRE supera a bajo
// aunque esté al final de su ventana (60+0 > 10+40).
//
// [CALIBRAR] Ajustar con datos de LTV real cuando estén disponibles.
// [DB-READY] Candidato directo para tabla priority_score_configs.
export const VALUE_SCORES: Record<ValueTier, number> = {
  super_vip: 60,
  vip:       45,
  medio:     25,
  bajo:      10,
}

// ── Reglas de clasificación en segmento de difusión [DB-READY] ───────────────
//
// El orden importa: se aplica el PRIMER match. Reglas más específicas (alto valor
// + inactividad corta) van primero.
//
// Semántica de cada segmento → guía de uso para el operador:
//
//  URGENTE            Mensaje directo: "Te extrañamos, volvé". Alta conv. esperada.
//  PRIORITARIA        Mensaje con incentivo: bono, free spins, cashback.
//  ESTANDAR           Oferta especial: promoción exclusiva, torneo, novedad.
//  FRIA_ALTO_VALOR    Win-back agresivo: oferta máxima para no perderlos.
//                     VIP/ALTO con 4–6 meses sin actividad. Alta inversión, alto retorno.
//  FRIA               Mensaje de bajo costo: no invertir en incentivo grande.
//
// [DB-READY] Toda esta tabla es candidata para moverse a una config DB en v2,
//            permitiendo que el admin agregue/modifique segmentos sin deploy.
export const REACTIVATION_SEGMENT_RULES: SegmentRule[] = [
  // ── SUPER_VIP y VIP — de más reciente a más antiguo ─────────────────────
  {
    segment: 'REACTIVACION_URGENTE',
    tiers:   ['super_vip', 'vip'],
    minDays: 7,
    maxDays: 30,
  },
  {
    segment: 'REACTIVACION_PRIORITARIA',
    tiers:   ['super_vip', 'vip'],
    minDays: 31,
    maxDays: 90,
  },
  {
    segment: 'REACTIVACION_ESTANDAR',
    tiers:   ['super_vip', 'vip'],
    minDays: 91,
    maxDays: 120,
  },
  {
    // Win-back: Super VIP hasta 6 meses, VIP hasta 5 meses.
    // Requiere oferta máxima — no enviar mensaje genérico a este segmento.
    segment: 'REACTIVACION_FRIA_ALTO_VALOR',
    tiers:   ['super_vip', 'vip'],
    minDays: 121,
    maxDays: 150,
  },
  {
    // Solo Super VIP llega hasta 180 días (6 meses). VIP termina en 150d.
    segment: 'REACTIVACION_FRIA_ALTO_VALOR',
    tiers:   ['super_vip'],
    minDays: 151,
    maxDays: 180,
  },
  // ── MEDIO ────────────────────────────────────────────────────────────────
  {
    segment: 'REACTIVACION_PRIORITARIA',
    tiers:   ['medio'],
    minDays: 14,
    maxDays: 30,
  },
  {
    segment: 'REACTIVACION_ESTANDAR',
    tiers:   ['medio'],
    minDays: 31,
    maxDays: 60,
  },
  // ── BAJO ─────────────────────────────────────────────────────────────────
  {
    segment: 'REACTIVACION_FRIA',
    tiers:   ['bajo'],
    minDays: 30,
    maxDays: 45,
  },
]

// ── Cooldown de recontacto por tier [DB-READY] ────────────────────────────────
//
// Días mínimos entre mensajes para el mismo contacto, según su tier.
// Mayor valor → cooldown menor (el ROI esperado justifica la frecuencia).
//
// [DB-READY] Mover a contact_frequency_rules para configuración por operador.
// [CALIBRAR] El cooldown óptimo depende de la tasa de apertura y unsubscribe.
export const RECONTACT_COOLDOWN_DAYS: Record<ValueTier, number> = {
  super_vip: 3,
  vip:       5,
  medio:     7,
  bajo:      14,
}

// ── Umbrales de monto para tier por valor monetario [DB-READY] [CALIBRAR] ─────
//
// Se usan cuando total_deposit_amount está disponible (post-migración de datos).
// Mientras el campo sea NULL, el sistema usa segment como fallback.
//
// [CALIBRAR] Estos umbrales deben revisarse con la distribución real de montos.
//            Actualmente son referencias genéricas (USD/ARS sin convertir).
//            Pasos: 1) importar montos, 2) ver percentil p75/p90/p99, 3) ajustar.
// [DB-READY] Candidato para tabla priority_score_configs junto con los demás umbrales.
export const DEPOSIT_AMOUNT_TIERS: Array<{ minAmount: number; tier: ValueTier }> = [
  { minAmount: 10_000, tier: 'super_vip' },
  { minAmount: 3_000,  tier: 'vip'       },
  { minAmount: 500,    tier: 'medio'     },
  { minAmount: 0,      tier: 'bajo'      },
]
