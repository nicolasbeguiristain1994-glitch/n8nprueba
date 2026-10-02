// @vitest-environment node
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { startCampaignScheduler } = require('../../campaign-scheduler.cjs')
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })
describe('local campaign scheduler timer', () => {
  it('does not start on import and stays inert when disabled', async () => {
    expect(vi.getTimerCount()).toBe(0)
    const fetchImpl = vi.fn()
    const timer = startCampaignScheduler({ env: {}, fetchImpl })
    await timer.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    timer.stop()
  })
  it('uses loopback, exact credential, timeout and no redirect following', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const timer = startCampaignScheduler({ port: 3210, env: { CAMPAIGN_SCHEDULER_ENABLED: 'true', CRON_SECRET: 'synthetic' }, fetchImpl })
    await timer.tick()
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3210/api/cron/campaigns', expect.objectContaining({
      method: 'POST', redirect: 'error', headers: { 'x-cron-secret': 'synthetic' }, signal: expect.any(AbortSignal),
    }))
    timer.stop()
  })
  it('suppresses overlap and never sends after stop', async () => {
    let finish!: (value: Response) => void
    const fetchImpl = vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve }))
    const timer = startCampaignScheduler({ env: { CAMPAIGN_SCHEDULER_ENABLED: 'true', CRON_SECRET: 'synthetic' }, fetchImpl })
    const first = timer.tick()
    await timer.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    finish(new Response('{}'))
    await first
    timer.stop()
    await timer.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('fails closed on invalid port or missing secret', async () => {
    const fetchImpl = vi.fn()
    const timer = startCampaignScheduler({ port: '3000@remote.invalid', env: { CAMPAIGN_SCHEDULER_ENABLED: 'true', CRON_SECRET: 'synthetic' }, fetchImpl })
    await timer.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    timer.stop()
  })
})
