import { query } from './db'
import { dashboardSnapshotQuery } from './dashboard-snapshot-query'
import type { Platform } from './casino-agents'
import { casinoDashboard, type CasinoDashboardData } from './dashboard-casino'
import { overviewSql, type PlatformActivity } from './dashboard-overview'
import { depositAnalytics, depositAnalyticsSql, type DepositAggregateRow, type DepositAnalytics } from './dashboard-deposits'
import { DashboardSnapshotStore } from './dashboard-snapshot-store'

export interface DashboardScope { platform: Platform; from: string; to: string; agent: string | null }
interface Results { casino: CasinoDashboardData; overview: { activity: PlatformActivity[] }; deposits: DepositAnalytics }
type Kind = keyof Results
const key = (kind: Kind, scope: DashboardScope) => JSON.stringify([kind, scope.platform, scope.from, scope.to, scope.agent])
type Runtime = typeof globalThis & { __dashboardSnapshotV1?: DashboardSnapshotStore }
const runtime = globalThis as Runtime
export const dashboardSnapshot = runtime.__dashboardSnapshotV1 ??= new DashboardSnapshotStore()

async function load<K extends Kind>(kind: K, scope: DashboardScope): Promise<Results[K]> {
  const { platform, from, to, agent } = scope
  const runQuery = process.env.NODE_ENV === 'production' ? dashboardSnapshotQuery : query
  if (kind === 'casino') return await casinoDashboard(platform, from, to, agent, runQuery) as Results[K]
  if (kind === 'overview') return { activity: await runQuery<PlatformActivity>(overviewSql(platform), [from, to, agent]) } as Results[K]
  const rows = await runQuery<DepositAggregateRow>(depositAnalyticsSql(platform), [from, to, agent])
  return depositAnalytics(rows, platform) as Results[K]
}

export async function readDashboardSnapshot<K extends Kind>(kind: K, scope: DashboardScope, fresh = false) {
  // Development/integration queries remain live; production uses the exact same
  // loaders for requests and revalidation, without changing calculations.
  if (process.env.NODE_ENV !== 'production') return { value: await load(kind, scope), updatedAt: Date.now() }
  return dashboardSnapshot.read(key(kind, scope), () => load(kind, scope), fresh)
}
