/**
 * health-recommendation.service
 * @presentation Concern — separado del cálculo de score (SRP)
 *
 * Transforma el estado de salud de una línea en una recomendación
 * accionable para el operador. No contiene lógica de puntuación.
 */

import type { HealthComponents } from './health-calculator.service'

export function resolveRecommendation(
  components: HealthComponents,
  status:     string,
  score:      number,
): string {
  if (status === 'paused')
    return 'Reanudar el calentamiento para recuperar la salud de la línea.'

  if (components.inactivityPenalty >= 18)
    return 'Inactividad prolongada detectada. Verificar conectividad y reanudar envíos.'

  if (components.failurePenalty >= 10)
    return 'Alta tasa de fallos. Verificar estado de la instancia en Evolution API.'

  if (components.trendScore < 6)
    return 'Consistencia baja en los últimos 7 días. Asegurar que el proceso de calentamiento corra correctamente.'

  if (score < 40)
    return 'Salud crítica. Revisar configuración antes de incorporar la línea a campañas.'

  if (score < 70)
    return 'Progresando correctamente. Mantener el calentamiento hasta alcanzar salud óptima.'

  return 'Línea en buen estado. Puede incorporarse a campañas de bajo volumen.'
}
