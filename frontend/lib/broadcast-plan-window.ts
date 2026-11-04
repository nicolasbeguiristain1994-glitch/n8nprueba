export interface StoredBroadcastPlan {
  startsAt: string; endsAt: string
  assignments: Record<string,string>
}
export function isBroadcastPlanOpen(plan: StoredBroadcastPlan | null | undefined, now = Date.now()): boolean {
  return !plan || (now >= Date.parse(plan.startsAt) && now < Date.parse(plan.endsAt))
}
/** Bound claims and legacy processors to the reviewed destinations and window. */
export function broadcastPlanRoutingSQL(campaignAlias: string, phoneExpr: string, lineExpr: string) {
  const plan = `NULLIF(to_jsonb(${campaignAlias})->'broadcast_plan','null'::jsonb)`
  return `(${plan} IS NULL OR (
    clock_timestamp() >= (${plan}->>'startsAt')::timestamptz AND clock_timestamp() < (${plan}->>'endsAt')::timestamptz
    AND ${plan}->'assignments'->>regexp_replace(${phoneExpr},'[^0-9]','','g') = (${lineExpr})::text))`
}
