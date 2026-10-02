// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { argToday, validateSyncRequest } from '@/lib/casino-sync-validation'

const NOW   = new Date('2026-09-13T15:00:00.000Z')   // 12:00 ART
const TODAY = '2026-09-13'

describe('argToday', () => {
  it('uses Argentina time (UTC-3)', () => {
    expect(argToday(new Date('2026-09-14T02:00:00.000Z'))).toBe('2026-09-13')
  })
})

describe('validateSyncRequest', () => {
  const v = (qs: string) => validateSyncRequest(new URLSearchParams(qs), NOW)

  it('defaults to zeus in auto mode', () => {
    expect(v('')).toEqual({ ok: true, value: { platform: 'zeus', mode: 'auto', desde: null, hasta: null, agentes: null } })
  })

  it('fills hasta with today (ART) in range mode', () => {
    expect(v('platform=bet30&desde=2026-09-01')).toMatchObject({ ok: true, value: { mode: 'range', hasta: TODAY } })
  })

  it('accepts today as hasta but rejects tomorrow', () => {
    expect(v(`desde=2026-09-01&hasta=${TODAY}`).ok).toBe(true)
    expect(v('desde=2026-09-01&hasta=2026-09-14').ok).toBe(false)
  })

  it('dedupes and trims agents', () => {
    expect(v('agentes=a, b,a')).toMatchObject({ ok: true, value: { agentes: ['a', 'b'] } })
  })

  it('rejects more than 20 agents', () => {
    const many = Array.from({ length: 21 }, (_, i) => `a${i}`).join(',')
    expect(v(`agentes=${many}`).ok).toBe(false)
  })
})

