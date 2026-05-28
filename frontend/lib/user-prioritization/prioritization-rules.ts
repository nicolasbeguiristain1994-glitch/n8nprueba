import { INACTIVITY_WINDOWS, RECONTACT_COOLDOWN_DAYS, DEPOSIT_AMOUNT_TIERS } from './config'
import { resolveValueTier } from './scoring'
import type { ValueTier, InactivityWindow } from './config'

export interface EligibilityInput {
  status:              string
  doNotContact:        boolean
  optInMarketing:      boolean
  deletedAt:           Date | null
  lastDepositAt:       Date | null
  segment:             string | null
  totalDepositAmount:  number | null
  daysInactive:        number | null
  // Días desde el último mensaje enviado a este contacto (null = nunca contactado)
  daysSinceLastMessage: number | null
}

export interface EligibilityResult {
  eligible:    boolean
  skipReasons: string[]
  valueTier:   ValueTier
}

/**
 * Config que puede sobreescribir los hardcoded de config.ts.
 * Cuando se omite, las funciones usan los valores de config.ts.
 */
export interface EligibilityConfig {
  inactivityWindows:     Record<ValueTier, InactivityWindow>
  recontactCooldownDays: Record<ValueTier, number>
  depositAmountTiers:    Array<{ minAmount: number; tier: ValueTier }>
}

const DEFAULT_ELIGIBILITY_CONFIG: EligibilityConfig = {
  inactivityWindows:     INACTIVITY_WINDOWS,
  recontactCooldownDays: RECONTACT_COOLDOWN_DAYS,
  depositAmountTiers:    DEPOSIT_AMOUNT_TIERS,
}

/**
 * Determina si un contacto puede recibir un mensaje de reactivación.
 *
 * Las ventanas de inactividad son ESPECÍFICAS POR TIER: un VIP puede estar
 * hasta 120 días inactivo y seguir siendo elegible; un bajo solo en 30–45 días.
 * Esto alinea el módulo con el objetivo de maximizar ROI real:
 * el intento de reactivación se justifica cuando LTV_esperado > costo_del_intento.
 *
 * El cooldown de recontacto también varía por tier: los VIPs toleran más
 * frecuencia que los bajos.
 *
 * Razones de skip posibles:
 *   deleted            → soft-deleted en contacts
 *   status_invalid     → suspendido, cerrado u otro estado no operativo
 *   do_not_contact     → flag explícito en el contacto
 *   opted_out          → opt_in_marketing = false
 *   no_deposit_history → sin last_deposit_at (no se puede calcular inactividad)
 *   still_active       → depositó hace menos de window.minDays para su tier
 *   too_cold           → inactivo por más de window.maxDays para su tier
 *   recently_messaged  → contactado hace menos de recontactCooldownDays[tier]
 */
export function checkEligibility(
  input: EligibilityInput,
  cfg:   EligibilityConfig = DEFAULT_ELIGIBILITY_CONFIG,
): EligibilityResult {
  const reasons: string[] = []
  const valueTier = resolveValueTier(input.segment, input.totalDepositAmount, cfg.depositAmountTiers)
  const window    = cfg.inactivityWindows[valueTier]

  if (input.deletedAt !== null) {
    reasons.push('deleted')
  }

  if (!['active', 'inactive'].includes(input.status)) {
    reasons.push('status_invalid')
  }

  if (input.doNotContact) {
    reasons.push('do_not_contact')
  }

  if (!input.optInMarketing) {
    reasons.push('opted_out')
  }

  if (!input.lastDepositAt) {
    reasons.push('no_deposit_history')
  } else if (input.daysInactive !== null) {
    if (input.daysInactive < window.minDays) {
      reasons.push('still_active')
    } else if (input.daysInactive > window.maxDays) {
      reasons.push('too_cold')
    }
  }

  const cooldown = cfg.recontactCooldownDays[valueTier]
  if (input.daysSinceLastMessage !== null && input.daysSinceLastMessage < cooldown) {
    reasons.push('recently_messaged')
  }

  return { eligible: reasons.length === 0, skipReasons: reasons, valueTier }
}
