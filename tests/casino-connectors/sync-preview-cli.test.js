'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { parseSyncArgs } = require('../../src/casino-connectors/sync/cli-args')
const { previewPoolOptions } = require('../../src/casino-connectors/sync/preview')
const scriptPath = path.resolve(__dirname, '../../scripts/sync-casino-players-live.js')
const source = fs.readFileSync(scriptPath, 'utf8')
const ARGS = ['--preview', '--platform=zeus', '--agentes=betcoin', '--desde=2026-09-12', '--hasta=2026-09-12']

// VM requires are an explicit allowlist: there is no pg client, provider or env
// inherited from the test process. No CLI subprocess is launched.
async function runFixture({ args = ARGS, databaseUrl = 'postgres://fixture:synthetic@fixture.invalid/fixture', setupError, previewResult } = {}) {
  let stdout = '', stderr = ''
  const processMock = { argv: ['node', scriptPath, ...args], env: { DATABASE_URL: databaseUrl, CASINO_SYNC_PAUSED: '1' },
    stdout: { write: s => { stdout += s } }, stderr: { write: s => { stderr += s } }, once: jest.fn(), exitCode: 0,
    exit: jest.fn(code => { processMock.exitCode = code; throw new Error('VM_EXIT') }) }
  const end = jest.fn(async () => {})
  const on = jest.fn()
  const Pool = jest.fn(function (options) { if (setupError) throw setupError; this.options = options; this.end = end; this.on = on })
  const createConnector = jest.fn(() => { throw new Error('Unexpected provider access') })
  const runSync = jest.fn(async () => ({ runId: 'synthetic-run', status: 'skipped', exitCode: 3 }))
  const runPreview = jest.fn(async () => previewResult || { mode: 'preview', read_only: true, status: 'complete', exitCode: 0 })
  const createLogger = jest.fn(() => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }))
  const modules = {
    pg: { Pool },
    '../src/casino-connectors/index': { createConnector, getDefaultPlatform: () => 'zeus' },
    '../src/lib/logger': { createLogger },
    '../src/casino-connectors/sync/cli-args': { parseSyncArgs: (argv, opts) => parseSyncArgs(argv, { ...opts, now: new Date('2026-09-15T15:00:00Z') }) },
    '../src/casino-connectors/sync/runner': { runSync, EXIT: { FAILED: 1, USAGE: 2 } },
    '../src/casino-connectors/sync/preview': { runPreview, previewPoolOptions },
  }
  try {
    vm.runInNewContext(source, { require: name => {
      if (!(name in modules)) throw new Error(`Unmocked dependency: ${name}`)
      return modules[name]
    }, process: processMock, AbortController }, { filename: scriptPath })
  } catch (err) { if (err.message !== 'VM_EXIT') throw err }
  await new Promise(resolve => setImmediate(resolve))
  return { stdout, stderr, exitCode: processMock.exitCode, Pool, runSync, runPreview, createConnector, createLogger, end, processMock }
}

describe('preview CLI routing without processes, providers or DB', () => {
  it('rejects invalid preview before creating a pool, runner or provider; does not echo raw arguments', async () => {
    const result = await runFixture({ args: [...ARGS, '--secret=synthetic-private-value'] })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).not.toContain('synthetic-private-value')
    expect(result.Pool).not.toHaveBeenCalled()
    expect(result.runPreview).not.toHaveBeenCalled()
    expect(result.runSync).not.toHaveBeenCalled()
    expect(result.createConnector).not.toHaveBeenCalled()
  })
  it('runs the explicit read-only path while paused and returns its result', async () => {
    const result = await runFixture()
    expect(result.exitCode).toBe(0)
    expect(result.Pool.mock.calls[0][0]).toMatchObject({ max: 1, options: '-c default_transaction_read_only=on' })
    expect(result.runPreview).toHaveBeenCalledTimes(1)
    expect(result.runPreview.mock.calls[0][0]).toMatchObject({ preview: true, platform: 'zeus', agentes: ['betcoin'] })
    expect(result.runSync).not.toHaveBeenCalled()
    expect(result.createConnector).not.toHaveBeenCalled()
    expect(result.createLogger).not.toHaveBeenCalled()
    expect(result.end).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'preview', status: 'complete', read_only: true })
    expect(result.stderr).toBe('')
  })
  it('propagates a blocked preview exit status', async () => {
    const result = await runFixture({ previewResult: { mode: 'preview', status: 'blocked', exitCode: 1, error_code: 'LEGACY_RANGE_UNCLASSIFIED' } })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked', error_code: 'LEGACY_RANGE_UNCLASSIFIED' })
    expect(result.end).toHaveBeenCalledTimes(1)
  })
  it.each([
    { databaseUrl: 'synthetic-private-malformed-url' },
    { setupError: new Error('postgres://sensitive-provider-token') },
  ])('sanitizes setup failures and never calls the write runner', async options => {
    const result = await runFixture(options)
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({ mode: 'preview', read_only: true, status: 'failed', error_code: 'PREVIEW_SETUP_FAILED' })
    expect(result.stdout).toBe('')
    expect(result.runSync).not.toHaveBeenCalled()
    expect(result.runPreview).not.toHaveBeenCalled()
  })
  it('preserves normal runner dispatch and writer pool configuration', async () => {
    const result = await runFixture({ args: ['--platform=zeus', '--auto'] })
    expect(result.runPreview).not.toHaveBeenCalled()
    expect(result.runSync).toHaveBeenCalledTimes(1)
    expect(result.runSync.mock.calls[0][0]).not.toHaveProperty('preview')
    expect(result.Pool.mock.calls[0][0]).not.toHaveProperty('options')
    expect(result.Pool.mock.calls[0][0]).toMatchObject({ keepAlive: true, connectionTimeoutMillis: 30000 })
    expect(result.exitCode).toBe(3)
    expect(result.end).toHaveBeenCalledTimes(1)
  })
  it('requires DATABASE_URL before any connection attempt', async () => {
    const result = await runFixture({ databaseUrl: '' })
    expect(result.exitCode).toBe(1)
    expect(result.Pool).not.toHaveBeenCalled()
    expect(result.runPreview).not.toHaveBeenCalled()
    expect(result.runSync).not.toHaveBeenCalled()
  })
})
