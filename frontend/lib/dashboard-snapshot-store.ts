export const DASHBOARD_REFRESH_MS = 60_000
const MAX_AGE_MS = 5 * DASHBOARD_REFRESH_MS
const IDLE_MS = 15 * DASHBOARD_REFRESH_MS
const MAX_ENTRIES = 48
export interface DashboardSnapshot<T> { value: T; updatedAt: number }
type Loader = () => Promise<unknown>
type Entry = { snapshot?: DashboardSnapshot<unknown>; pending?: Promise<DashboardSnapshot<unknown>>; load: Loader; accessedAt: number }

// Only shared financial aggregates belong here. Authentication, permissions,
// personal CRM tasks and message outcomes are always read afresh by their APIs.
export class DashboardSnapshotStore {
  private entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setInterval>
  private warming?: Promise<void>

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

  private warm(defaults: () => Array<{ key: string; load: Loader }>): Promise<void> {
    if (this.warming) return this.warming
    this.warming = (async () => {
      const pinned = defaults(), keys = new Set(pinned.map(item => item.key))
      for (const [key, entry] of this.entries) if (!keys.has(key) && Date.now() - entry.accessedAt > IDLE_MS && !entry.pending) this.entries.delete(key)
      for (const item of pinned) this.entry(item.key, item.load)
      // One background query at a time, leaving the connection pool to requests.
      for (const entry of [...this.entries.values()]) {
        if (entry.snapshot && Date.now() - entry.snapshot.updatedAt < DASHBOARD_REFRESH_MS) continue
        try { await this.refresh(entry) } catch { console.warn('[dashboard] Refresh unavailable; will retry') }
      }
    })().finally(() => { this.warming = undefined })
    return this.warming
  }

  async start(defaults: () => Array<{ key: string; load: Loader }>) {
    if (!this.timer) {
      this.timer = setInterval(() => { void this.warm(defaults) }, DASHBOARD_REFRESH_MS)
      this.timer.unref?.()
    }
    await this.warm(defaults)
  }

  reset() { clearInterval(this.timer); this.timer = undefined; this.entries.clear() }
}
