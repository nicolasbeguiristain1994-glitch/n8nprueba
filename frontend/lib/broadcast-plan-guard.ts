import { isBroadcastPlanOpen, type StoredBroadcastPlan } from './broadcast-plan-window'
export { isBroadcastPlanOpen, type StoredBroadcastPlan } from './broadcast-plan-window'
import { CampaignRiskError } from './campaign-risk'
export class BroadcastPlanSendError extends CampaignRiskError {
  constructor() { super('El envío está fuera del horario o del reparto aprobado. Volvé a Planificar difusión.') }
}
export function assertBroadcastPlanSend(plan: StoredBroadcastPlan | null | undefined, phone: string, lineId: string | null | undefined, now = Date.now()) {
  if (plan && (!isBroadcastPlanOpen(plan,now) || !lineId || plan.assignments[phone.replace(/\D/g,'')] !== lineId)) throw new BroadcastPlanSendError()
}
