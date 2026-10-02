'use strict'

const {
  isCasinoSyncPaused,
  CASINO_SYNC_PAUSED_ENV,
  CASINO_SYNC_PAUSED_CODE,
} = require('../../src/casino-connectors/sync/maintenance')

describe('isCasinoSyncPaused()', () => {
  const env = value => (value === undefined ? {} : { [CASINO_SYNC_PAUSED_ENV]: value })

  it.each([
    [undefined], [''], ['   '], ['0'], [' 0 '], ['false'], ['FALSE'], [' False '],
  ])('%p no pausa (comportamiento existente)', value => {
    expect(isCasinoSyncPaused(env(value))).toBe(false)
  })

  it.each([
    ['1'], ['true'], ['TRUE'], [' yes '], ['no'], ['off'], ['2'], ['pausado'], ['0.0'], ['falso'],
  ])('%p pausa (valores desconocidos fallan cerrados)', value => {
    expect(isCasinoSyncPaused(env(value))).toBe(true)
  })

  it('lee process.env por defecto', () => {
    const saved = process.env[CASINO_SYNC_PAUSED_ENV]
    try {
      process.env[CASINO_SYNC_PAUSED_ENV] = '1'
      expect(isCasinoSyncPaused()).toBe(true)
      process.env[CASINO_SYNC_PAUSED_ENV] = '0'
      expect(isCasinoSyncPaused()).toBe(false)
      delete process.env[CASINO_SYNC_PAUSED_ENV]
      expect(isCasinoSyncPaused()).toBe(false)
    } finally {
      if (saved === undefined) delete process.env[CASINO_SYNC_PAUSED_ENV]
      else process.env[CASINO_SYNC_PAUSED_ENV] = saved
    }
  })

  it('el código de error es estable', () => {
    expect(CASINO_SYNC_PAUSED_CODE).toBe('CASINO_SYNC_PAUSED')
  })
})
