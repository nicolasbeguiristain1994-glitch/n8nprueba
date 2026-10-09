// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DashboardSnapshotStore } from '../dashboard-snapshot-store'
let store: DashboardSnapshotStore
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-08T12:00:00Z')); store = new DashboardSnapshotStore() })
afterEach(() => { store.reset(); vi.useRealTimers() })
it('primes before traffic and shares simultaneous reads without duplicate queries', async () => {
  let resolve!: (value: number) => void
  const load = vi.fn(() => new Promise<number>(r => { resolve = r }))
  const startup = store.start(() => [{ key: 'default', load }])
  const one = store.read('default', load), two = store.read('default', load)
  await Promise.resolve(); expect(load).toHaveBeenCalledOnce()
  resolve(7); await startup
  expect((await one).value).toBe(7); expect(await one).toEqual(await two)
  await store.start(() => [{ key: 'default', load }]); expect(load).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1)
})
it('serves the prior result while one background refresh runs and bounds staleness', async () => {
  await store.read('one', async () => 1)
  vi.advanceTimersByTime(61_000)
  let resolve!: (value: number) => void
  const load = vi.fn(() => new Promise<number>(r => { resolve = r }))
  expect((await store.read('one', load)).value).toBe(1)
  expect((await store.read('one', load)).value).toBe(1); expect(load).toHaveBeenCalledOnce()
  resolve(2); await store.read('one', load, true)
  expect((await store.read('one', load)).value).toBe(2)
  vi.advanceTimersByTime(301_000)
  await expect(store.read('one', async () => { throw Error('offline') })).rejects.toThrow('offline')
  expect((await store.read('one', async () => 3)).value).toBe(3)
})
it('manual refresh waits for fresh results, with isolated keys and a bounded LRU', async () => {
  expect((await store.read('royal/7d', async () => 1)).value).toBe(1)
  expect((await store.read('royal/7d', async () => 2, true)).value).toBe(2)
  expect((await store.read('bigwin/7d', async () => 3)).value).toBe(3)
  expect((await store.read('royal/30d', async () => 4)).value).toBe(4)
  for (let i = 0; i < 60; i++) { vi.advanceTimersByTime(1); await store.read(`custom/${i}`, async () => i) }
  const load = vi.fn(async () => 99)
  expect((await store.read('royal/7d', load)).value).toBe(99); expect(load).toHaveBeenCalledOnce()
})
it('refreshes sequentially, tracks new calendar defaults, and expires idle custom scopes', async () => {
  let day = 'day1'
  const load = vi.fn(async () => day)
  const defaults = () => [{ key: day, load }]
  await store.start(defaults)
  await store.read('custom', async () => 'old')
  day = 'day2'; await vi.advanceTimersByTimeAsync(16 * 60_000)
  expect((await store.read('day2', load)).value).toBe('day2')
  const custom = vi.fn(async () => 'new'); expect((await store.read('custom', custom)).value).toBe('new'); expect(custom).toHaveBeenCalledOnce()
})
