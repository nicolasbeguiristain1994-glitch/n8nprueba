import type { MissingContact } from './missing-contact-types'

export const MISSING_CONTACT_REFRESH_MS = 60_000
const MAX_AGE_MS = 5 * MISSING_CONTACT_REFRESH_MS
export type MissingContactSnapshot = { users: MissingContact[]; updatedAt: number }
type Loader = () => Promise<MissingContact[]>
const identity = (row: Pick<MissingContact, 'platform' | 'username'>) => JSON.stringify([row.platform, row.username])

// Server-only data, never an HTTP/user permission cache. Each request must still
// authorize against the current DB user and apply that user's agent scope.
export class MissingContactSnapshotStore {
  private snapshot?: MissingContactSnapshot
  private pending?: Promise<MissingContactSnapshot>
  private generation = 0
  private removed = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>

  refresh(load: Loader): Promise<MissingContactSnapshot> {
    if (this.pending) return this.pending
    const startedGeneration = this.generation
    this.pending = Promise.resolve().then(load).then(users => {
      // A query begun before an import committed must not resurrect its accounts.
      const visible = users.filter(row => (this.removed.get(identity(row)) ?? 0) <= startedGeneration)
      this.snapshot = { users: visible, updatedAt: Date.now() }
      for (const [key, generation] of this.removed) {
        if (generation <= startedGeneration) this.removed.delete(key)
      }
      return this.snapshot
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  async read(load: Loader): Promise<MissingContactSnapshot> {
    const snapshot = this.snapshot
    if (!snapshot || Date.now() - snapshot.updatedAt >= MAX_AGE_MS) return this.refresh(load)
    if (Date.now() - snapshot.updatedAt >= MISSING_CONTACT_REFRESH_MS) {
      void this.refresh(load).catch(() => console.warn('[missing contacts] Background refresh failed'))
    }
    return snapshot
  }

  remove(rows: Array<Pick<MissingContact, 'platform' | 'username'>>) {
    const generation = ++this.generation
    for (const row of rows) this.removed.set(identity(row), generation)
    if (this.snapshot) this.snapshot = { ...this.snapshot, users: this.snapshot.users.filter(row => !this.removed.has(identity(row))) }
  }

  async start(load: Loader) {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh(load).catch(() => console.warn('[missing contacts] Background refresh failed'))
      }, MISSING_CONTACT_REFRESH_MS)
      this.timer.unref?.()
    }
    // Prime before Next accepts traffic, including on a fresh deployment.
    await this.read(load)
  }

  reset() {
    clearInterval(this.timer); this.timer = undefined
    this.snapshot = undefined; this.removed.clear(); this.generation = 0
  }
}

type Runtime = typeof globalThis & { __missingContactSnapshotV1?: MissingContactSnapshotStore }
const runtime = globalThis as Runtime
export const missingContactSnapshot = runtime.__missingContactSnapshotV1 ??= new MissingContactSnapshotStore()

const argentinaDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' })

export function missingContactCutoff(months: number, now = new Date()) {
  if (!months) return { day: '', timestamp: -Infinity }
  const [year, month, day] = argentinaDay.format(now).split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 - months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  const since = target.toISOString().slice(0, 10)
  return { day: since, timestamp: Date.parse(since + 'T00:00:00-03:00') }
}

export function filterMissingContactSnapshot(snapshot: MissingContactSnapshot, agents: string[], filters: {
  agent: string; platform: string; months: number; includeNew: boolean; q: string; page: number
}, download = false) {
  const selected = new Set(filters.agent ? agents.filter(agent => agent === filters.agent) : agents)
  const since = missingContactCutoff(filters.months)
  const search = filters.q.toLowerCase()
  const active: MissingContact[] = [], newlySeen: MissingContact[] = []
  for (const row of snapshot.users) {
    if (!selected.has(row.agent) || (filters.platform && row.platform !== filters.platform) || (search && !row.username.includes(search))) continue
    if (row.last_movement !== null && row.last_movement >= since.day) active.push(row)
    else if (filters.includeNew && row.first_seen_at !== null && Date.parse(row.first_seen_at) >= since.timestamp) {
      // Match the live query: an older movement is outside the chosen period.
      newlySeen.push({ ...row, last_movement: null })
    }
  }
  newlySeen.sort((a, b) => Date.parse(b.first_seen_at!) - Date.parse(a.first_seen_at!)
    || a.platform.localeCompare(b.platform) || a.username.localeCompare(b.username))
  const users = active.concat(newlySeen)
  if (download && users.length > 100000) throw new Error('Hay más de 100.000 usuarios. Filtrá por agente o plataforma antes de descargar.')
  return { users: download ? users : users.slice((filters.page - 1) * 50, filters.page * 50), total: users.length, agents,
    updatedAt: new Date(snapshot.updatedAt).toISOString() }
}
