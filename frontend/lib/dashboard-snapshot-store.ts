export const DASHBOARD_REFRESH_MS = 60_000
const MAX_AGE_MS = 5 * DASHBOARD_REFRESH_MS
const MAX_ENTRIES = 48
export interface DashboardSnapshot<T> { value: T; updatedAt: number }
type Loader = () => Promise<unknown>
type Entry = { snapshot?: DashboardSnapshot<unknown>; pending?: Promise<DashboardSnapshot<unknown>>; load: Loader; accessedAt: number }

// Only shared financial aggregates belong here. Authentication, permissions,
// personal CRM tasks and message outcomes are always read afresh by their APIs.
export class DashboardSnapshotStore {
  private entries = new Map<string, Entry>()

  private entry(key: string, load: Loader): Entry {
    let entry = this.entries.get(key)
    if (!entry) {
      // Bounded LRU: custom date combinations cannot grow process memory forever.
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = [...this.entries].filter(([, e]) => !e.pending).sort((a, b) => a[1].accessedAt - b[1].accessedAt)[0]
        if (oldest) this.entries.delete(oldest[0])
      }
      entry = { load, accessedAt: Date.now() }
      if (this.entries.size < MAX_ENTRIES) this.entries.set(key, entry)
    }
    entry.load = load; entry.accessedAt = Date.now()
    return entry
  }

  private refresh(entry: Entry): Promise<DashboardSnapshot<unknown>> {
    if (!entry.pending) {
      entry.pending = Promise.resolve().then(entry.load).then(value => {
        entry.snapshot = { value, updatedAt: Date.now() }
        return entry.snapshot
      }).finally(() => { entry.pending = undefined })
    }
    return entry.pending
  }

  async read<T>(key: string, load: () => Promise<T>, fresh = false): Promise<DashboardSnapshot<T>> {
    const entry = this.entry(key, load), snapshot = entry.snapshot
    if (fresh || !snapshot || Date.now() - snapshot.updatedAt >= MAX_AGE_MS) return this.refresh(entry) as Promise<DashboardSnapshot<T>>
    if (Date.now() - snapshot.updatedAt >= DASHBOARD_REFRESH_MS) {
      void this.refresh(entry).catch(() => console.warn('[dashboard] Background refresh failed'))
    }
    return snapshot as DashboardSnapshot<T>
  }

  // Refresh only when a dashboard requests this scope. Precomputing every
  // preset repeatedly saturated disk I/O even when nobody was viewing it.
  reset() { this.entries.clear() }
}
