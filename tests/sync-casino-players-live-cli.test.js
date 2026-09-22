'use strict'

jest.mock('../scripts/lib/casino-sync-orchestrator', () => ({ runOrchestrator: jest.fn(async (opts) => ({ platform: opts.platform, locked: true, ok: true, results: [], _opts: opts })) }))

const { runOrchestrator } = require('../scripts/lib/casino-sync-orchestrator')
const { runCli } = require('../scripts/sync-casino-players-live')

describe('sync-casino-players-live.js runCli — config is the sole agent source', () => {
  beforeEach(() => jest.clearAllMocks())

  it('defaults to the full configured agent list for the platform (never a DB SELECT DISTINCT)', async () => {
    await runCli(['--platform=zeus', '--auto'], { pool: {} })
    const opts = runOrchestrator.mock.calls[0][0]
    expect(opts.agentes).toEqual(['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal'])
  })

  it('an --agentes override that only names configured agents is accepted as-is', async () => {
    await runCli(['--platform=zeus', '--agentes=betcoin,royal', '--auto'], { pool: {} })
    const opts = runOrchestrator.mock.calls[0][0]
    expect(opts.agentes).toEqual(['betcoin', 'royal'])
  })

  it('an --agentes override naming an agent NOT in the platform config is rejected, never silently passed through', async () => {
    const result = await runCli(['--platform=zeus', '--agentes=betcoin,not-a-real-agent', '--auto'], { pool: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not-a-real-agent/)
    expect(runOrchestrator).not.toHaveBeenCalled()
  })

  it('ganamos/argenbet resolve their agent list from agentIds keys', async () => {
    await runCli(['--platform=argenbet', '--auto'], { pool: {} })
    const opts = runOrchestrator.mock.calls[0][0]
    expect(opts.agentes.sort()).toEqual(['adminbtc', 'adminroyal', 'adminzeus'].sort())
  })
})
