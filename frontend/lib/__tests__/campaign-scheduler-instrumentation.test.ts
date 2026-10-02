// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from '../../instrumentation'

const runtime = globalThis as typeof globalThis & { __campaignSchedulerRegistration?: Promise<void> }
const fetchMock = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  delete runtime.__campaignSchedulerRegistration
  vi.stubEnv('NEXT_RUNTIME', 'nodejs')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PHASE', '')
  vi.stubEnv('AUTOMATION_SCHEDULER_ENABLED', '')
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'true')
  vi.stubEnv('CRON_SECRET', 'synthetic-runtime-secret')
  vi.stubEnv('PORT', '3217')
  fetchMock.mockReset().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  delete runtime.__campaignSchedulerRegistration
})

describe('Next runtime scheduler registration', () => {
  it('polls delayed automations independently of the campaign switch', async () => {
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'false'); vi.stubEnv('AUTOMATION_SCHEDULER_ENABLED', 'true')
    await register(); await vi.advanceTimersByTimeAsync(45000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('is inert on import and runs one delayed loopback timer after registration', async () => {
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    await register()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(44999)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3217/api/cron/campaigns', expect.objectContaining({
      method: 'POST', redirect: 'error', headers: { 'x-cron-secret': 'synthetic-runtime-secret' },
    }))
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('registers once even for concurrent calls or a reloaded instrumentation module', async () => {
    await Promise.all([register(), register(), register()])
    expect(vi.getTimerCount()).toBe(1)
    vi.resetModules()
    const reloaded = await import('../../instrumentation')
    await reloaded.register()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(45000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['NEXT_RUNTIME', 'edge'], ['NEXT_RUNTIME', ''], ['NODE_ENV', 'development'],
    ['NEXT_PHASE', 'phase-production-build'], ['CAMPAIGN_SCHEDULER_ENABLED', 'false'],
    ['CAMPAIGN_SCHEDULER_ENABLED', 'TRUE'], ['CRON_SECRET', ''],
  ])('does not register with %s=%s', async (key, value) => {
    vi.stubEnv(key, value)
    await register()
    expect(runtime.__campaignSchedulerRegistration).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not reserve registration while disabled, so later explicit enabling can start it', async () => {
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'false')
    await register()
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'true')
    await register()
    expect(vi.getTimerCount()).toBe(1)
  })
})
