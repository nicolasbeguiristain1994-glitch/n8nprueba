import { describe, expect, it } from 'vitest'
import { lineVolumeDate, recommendLineVolume, type LineVolumeDay, type LineVolumeInput } from '@/lib/line-volume-policy'

const now = '2026-10-20T18:00:00Z'
const day = (date: string, n = 25, patch: Partial<LineVolumeDay> = {}): LineVolumeDay => ({
  date, attempted: n, accepted: n, delivered: n, failed: 0, ecosystemRejected: 0,
  optOuts: 0, lastSentAt: `${date}T15:00:00Z`, ...patch,
})
const input = (patch: Partial<LineVolumeInput> = {}): LineVolumeInput => ({
  id: 'line', lineType: 'cloud', status: 'active', isConnected: true, sendingEnabled: true,
  campaignsAllowed: true, dailyLimit: 500, hourlyLimit: 100, dailyUsed: 0, hourlyUsed: 0,
  cloudStatus: 'active', quality: 'GREEN', lastMetaCheckAt: '2026-10-20T17:59:00Z',
  activeRiskReasons: [], recentDays: [], now, ...patch,
})
const favorable = [day('2026-10-17'), day('2026-10-18'), day('2026-10-19')]

describe('daily line volume advice', () => {
  it('starts with25, offers a conditional50, and does not mutate configured limits', () => {
    const source = input(); const before = structuredClone(source)
    expect(recommendLineVolume(source)).toMatchObject({ status: 'start', suggestedToday: 25,
      remainingToday: 25, availableNow: 25, nextHealthyDay: 50, qualifyingDays: 0, requiredDays: 3 })
    expect(source).toEqual(before)
  })
  it('uses the Argentine day at midnight instead of the UTC day', () => {
    expect(lineVolumeDate('2026-10-20T02:59:59Z')).toBe('2026-10-19')
    expect(lineVolumeDate('2026-10-20T03:00:00Z')).toBe('2026-10-20')
  })
  it('does not double after just one or two favorable days', () => {
    expect(recommendLineVolume(input({ recentDays: favorable.slice(0, 1) }))).toMatchObject({ suggestedToday: 25, qualifyingDays: 1 })
    expect(recommendLineVolume(input({ recentDays: favorable.slice(0, 2) }))).toMatchObject({ suggestedToday: 25, qualifyingDays: 2 })
  })
  it('increases one step after3 mature days at the current step', () => {
    expect(recommendLineVolume(input({ recentDays: favorable }))).toMatchObject({ suggestedToday: 50,
      nextHealthyDay: 75, status: 'increase', qualifyingDays: 0 })
  })
  it('cannot leap multiple stages on a single high-volume day', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-19', 1000)] })).suggestedToday).toBe(25)
  })
  it('requires the higher sample for subsequent steps', () => {
    const history = [...[11, 12, 13].map(n => day(`2026-10-${n}`)), ...[14, 15, 16].map(n => day(`2026-10-${n}`, 25))]
    expect(recommendLineVolume(input({ recentDays: history })).suggestedToday).toBe(50)
    const next = [...history.slice(0, 3), ...[14, 15, 16].map(n => day(`2026-10-${n}`, 50))]
    expect(recommendLineVolume(input({ recentDays: next })).suggestedToday).toBe(75)
  })
  it('tiny samples and days without activity cannot unlock growth', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-17', 3), day('2026-10-18', 4), day('2026-10-19', 0)] })).suggestedToday).toBe(25)
  })
  it('never uses today as a completed day for an increase', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-18'), day('2026-10-19'), day('2026-10-20')] })))
      .toMatchObject({ suggestedToday: 25, remainingToday: 0, qualifyingDays: 2 })
  })
  it('waits12h for the last send even if the calendar day has ended', () => {
    expect(recommendLineVolume(input({ now: '2026-10-20T04:00:00Z', lastMetaCheckAt: '2026-10-20T03:59:00Z',
      recentDays: [day('2026-10-17'), day('2026-10-18'), day('2026-10-19', 25, { lastSentAt: '2026-10-20T02:00:00Z' })] })))
      .toMatchObject({ suggestedToday: 25, qualifyingDays: 2 })
  })
  it('pending recent deliveries do not cause a reduction by themselves', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-20', 25, { delivered: 0, lastSentAt: now })] })).suggestedToday).toBe(25)
  })
  it('unconfirmed accepted messages cannot count as favorable deliveries', () => {
    expect(recommendLineVolume(input({ recentDays: favorable.map(d => ({ ...d, delivered: 0 })) })).suggestedToday).toBe(10)
  })
  it.each(['optOuts', 'ecosystemRejected'] as const)('a %s reduces advice without calling it a ban', key => {
    const source = input({ recentDays: [day('2026-10-20', 25, { [key]: 1 })] })
    const result = recommendLineVolume(source)
    expect(result).toMatchObject({ suggestedToday: 10, remainingToday: 0, status: 'reduce' })
    expect(recommendLineVolume(source)).toEqual(result)
    expect(result.reason).not.toMatch(/baneo|bloquead/)
  })
  it('holds increases for7 days after unfavorable evidence', () => {
    const source = input({ recentDays: [day('2026-10-16', 25, { optOuts: 1 }), ...favorable] })
    expect(recommendLineVolume(source)).toMatchObject({ suggestedToday: 10, qualifyingDays: 0 })
  })
  it('reduces on substantial observed failures without waiting for delivery receipts', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-20', 20, { failed: 4, accepted: 16, delivered: 0, lastSentAt: now })] })))
      .toMatchObject({ status: 'reduce', suggestedToday: 10 })
  })
  it('recommends stopping for a high preventive rejection rate', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-20', 50, { failed: 10, ecosystemRejected: 10 })] })))
      .toMatchObject({ status: 'stop', suggestedToday: 0, remainingToday: 0, nextHealthyDay: null })
  })
  it('stops for multiple withdrawals without calculating a bogus same-day rate', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-20', 0, { optOuts: 5 })] })).suggestedToday).toBe(0)
  })
  it('active account risk wins overGREEN quality and strong history', () => {
    expect(recommendLineVolume(input({ activeRiskReasons: ['Cuenta restringida'], recentDays: favorable })))
      .toMatchObject({ status: 'stop', suggestedToday: 0, reason: 'Cuenta restringida' })
  })
  it.each(['YELLOW', 'RED'])('quality%s stops advice', quality => {
    expect(recommendLineVolume(input({ quality })).suggestedToday).toBe(0)
  })
  it.each(['UNKNOWN', 'NA', null])('unknown quality%s never unlocks escalation', quality => {
    expect(recommendLineVolume(input({ quality, recentDays: favorable })))
      .toMatchObject({ suggestedToday: 25, nextHealthyDay: null, qualifyingDays: 0 })
  })
  it.each([null, 'invalid', '2026-10-20T17:53:59Z', '2026-10-20T18:01:00Z'])('missing/stale/future Meta check%s is unavailable', lastMetaCheckAt => {
    expect(recommendLineVolume(input({ lastMetaCheckAt }))).toMatchObject({ status: 'unavailable', suggestedToday: 0 })
  })
  it('a six-minute Meta check is still usable', () => {
    expect(recommendLineVolume(input({ lastMetaCheckAt: '2026-10-20T17:54:00Z' })).suggestedToday).toBe(25)
  })
  it.each([{ status: 'inactive' }, { isConnected: false }, { sendingEnabled: false }, { campaignsAllowed: false }, { cloudStatus: 'pending' }])('disabled line%j is stopped', patch => {
    expect(recommendLineVolume(input(patch))).toMatchObject({ status: 'stop', suggestedToday: 0 })
  })
  it('incomplete or retried history never unlocks growth', () => {
    expect(recommendLineVolume(input({ evidenceIncomplete: true, recentDays: favorable })))
      .toMatchObject({ suggestedToday: 25, nextHealthyDay: null })
  })
  it('unknown outcomes veto a day even with sufficient successful messages', () => {
    expect(recommendLineVolume(input({ recentDays: favorable.map(d => ({ ...d, unknown: 1 })) })).suggestedToday).toBe(25)
  })
  it('Evolution stays provisional instead of pretending to have Meta quality', () => {
    expect(recommendLineVolume(input({ lineType: 'evolution', quality: null, lastMetaCheckAt: null, recentDays: favorable })))
      .toMatchObject({ suggestedToday: 25, nextHealthyDay: null })
  })
  it('caps recommendation at configured daily limit and clamps remaining against rolling capacity', () => {
    expect(recommendLineVolume(input({ dailyLimit: 15, dailyUsed: 13, hourlyLimit: 1 })))
      .toMatchObject({ suggestedToday: 15, remainingToday: 2, availableNow: 1, nextHealthyDay: null })
    expect(recommendLineVolume(input({ dailyUsed: 999, hourlyUsed: 999 }))).toMatchObject({ remainingToday: 0, availableNow: 0 })
  })
  it('counts failed results in today total and never recommends a negative remainder', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-20', 26, { accepted: 25, delivered: 25, failed: 1 })] })))
      .toMatchObject({ attemptedToday: 26, acceptedToday: 25, remainingToday: 0 })
  })
  it('does not carry escalation through a seven-day inactivity gap', () => {
    const history = [day('2026-10-10'), day('2026-10-11'), day('2026-10-12')]
    expect(recommendLineVolume(input({ recentDays: history })).suggestedToday).toBe(25)
  })
  it('inactivity cannot raise a reduced10 back to25', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-10', 25, { optOuts: 1 })] })).suggestedToday).toBe(10)
  })
  it('discards pre-incident and same-day history after a risk review', () => {
    expect(recommendLineVolume(input({ recentDays: favorable, lastRiskAt: '2026-10-18T16:00:00Z' })))
      .toMatchObject({ suggestedToday: 10, qualifyingDays: 0 })
  })
  it('ignores future and older-than-window dates, sorts without mutating history', () => {
    const history = [day('2026-10-22'), day('2026-09-01'), ...favorable.slice().reverse()]
    const result = recommendLineVolume(input({ recentDays: history }))
    expect(result.suggestedToday).toBe(50)
    expect(history[0].date).toBe('2026-10-22')
    expect(result.recentDays).toHaveLength(3)
  })
  it('duplicate dates cannot impersonate three distinct favorable days', () => {
    expect(recommendLineVolume(input({ recentDays: [day('2026-10-19'), day('2026-10-19'), day('2026-10-19')] })))
      .toMatchObject({ suggestedToday: 25, qualifyingDays: 0 })
  })
  it('can recover from10 by following10 per day without exceeding advice', () => {
    const history = [day('2026-10-08', 25, { optOuts: 1 }),
      ...Array.from({ length: 11 }, (_, i) => day(`2026-10-${String(i + 9).padStart(2, '0')}`, 10))]
    expect(recommendLineVolume(input({ recentDays: history }))).toMatchObject({ suggestedToday: 25, status: 'increase' })
  })
  it('reviewing a risk incident cannot raise yesterday’s reduced recommendation', () => {
    const source = input({ recentDays: [day('2026-10-19', 25, { delivered: 19, accepted: 19, failed: 6 })] })
    expect(recommendLineVolume(source).suggestedToday).toBe(10)
    expect(recommendLineVolume({ ...source, lastRiskAt: '2026-10-20T16:00:00Z' }).suggestedToday).toBe(10)
  })
})
