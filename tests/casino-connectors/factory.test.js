'use strict'

const { createConnector, getDefaultPlatform } = require('../../src/casino-connectors/index')
const { ZeusConnector }  = require('../../src/casino-connectors/zeus/ZeusConnector')
const { Bet30Connector } = require('../../src/casino-connectors/bet30/Bet30Connector')

// ── Factories ─────────────────────────────────────────────────────────────────

function makePool() {
  return {
    connect: jest.fn(),
    query:   jest.fn(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createConnector() — Factory', () => {

  beforeEach(() => {
    process.env.ZEUS_API_KEY       = 'zeus-key'
    process.env.ZEUS_PLAYER_TOKEN  = 'zeus-token'
    process.env.BET30_API_KEY      = 'bet30-key'
    process.env.BET30_PLAYER_TOKEN = 'bet30-token'
  })

  afterEach(() => {
    delete process.env.ZEUS_API_KEY
    delete process.env.ZEUS_PLAYER_TOKEN
    delete process.env.BET30_API_KEY
    delete process.env.BET30_PLAYER_TOKEN
  })

  // ── Correct class resolution ────────────────────────────────────────────────

  it('returns a ZeusConnector instance for platform "zeus"', () => {
    expect(createConnector('zeus', makePool())).toBeInstanceOf(ZeusConnector)
  })

  it('returns a Bet30Connector instance for platform "bet30"', () => {
    expect(createConnector('bet30', makePool())).toBeInstanceOf(Bet30Connector)
  })

  it('Bet30Connector extends ZeusConnector (inherits full API logic)', () => {
    expect(createConnector('bet30', makePool())).toBeInstanceOf(ZeusConnector)
  })

  // ── Correct configuration ───────────────────────────────────────────────────

  it('zeus connector is configured with the Zeus base URL', () => {
    expect(createConnector('zeus', makePool()).baseUrl)
      .toBe('https://local-admin2.zeuscasino.fun')
  })

  it('bet30 connector is configured with the Bet30 base URL', () => {
    expect(createConnector('bet30', makePool()).baseUrl)
      .toBe('https://local-admin2.bet30.world')
  })

  it('zeus and bet30 connectors are independent (different credentials)', () => {
    process.env.ZEUS_API_KEY  = 'key-for-zeus'
    process.env.BET30_API_KEY = 'key-for-bet30'
    const zeus  = createConnector('zeus',  makePool())
    const bet30 = createConnector('bet30', makePool())
    expect(zeus.apiKey).toBe('key-for-zeus')
    expect(bet30.apiKey).toBe('key-for-bet30')
  })

  it('passes the shared pool to the connector', () => {
    const pool = makePool()
    const connector = createConnector('zeus', pool)
    expect(connector.pool).toBe(pool)
  })

  // ── Error cases ─────────────────────────────────────────────────────────────

  it('throws a descriptive error for an unknown platform name', () => {
    expect(() => createConnector('inexistente', makePool()))
      .toThrow('Unknown platform "inexistente"')
  })

  it('lists available platforms in the error message', () => {
    expect(() => createConnector('inexistente', makePool()))
      .toThrow(/zeus.*bet30|bet30.*zeus/)
  })

  it('propagates missing env var errors at construction time', () => {
    delete process.env.ZEUS_API_KEY
    expect(() => createConnector('zeus', makePool())).toThrow('ZEUS_API_KEY')
  })

  // ── getDefaultPlatform ──────────────────────────────────────────────────────

  describe('getDefaultPlatform()', () => {
    it('returns "zeus" as the default platform', () => {
      expect(getDefaultPlatform()).toBe('zeus')
    })
  })
})
