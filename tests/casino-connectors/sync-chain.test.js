const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')

const scriptPath = path.resolve(__dirname, '../../scripts/casino-sync-and-segment.js')
const source = fs.readFileSync(scriptPath, 'utf8')

async function runFixture({ codes = [0, 0], record = true, spawnError = false } = {}) {
  const runId = '11111111-1111-4111-8111-111111111111'
  const mockProcess = {
    argv: ['node', scriptPath, `--run-id=${runId}`, '--auto'],
    execPath: '/synthetic/node', env: { DATABASE_URL: 'synthetic-unused' },
    once: jest.fn(), exit: jest.fn(), exitCode: 0,
  }
  const setSegmentationStatus = jest.fn(async () => {
    if (record instanceof Error) throw record
    return record
  })
  let finished
  const done = new Promise(resolve => { finished = resolve })
  const end = jest.fn(async () => { finished() })
  const spawn = jest.fn(() => {
    const child = new EventEmitter()
    const code = codes[spawn.mock.calls.length - 1]
    process.nextTick(() => {
      if (spawnError) child.emit('error', { code: 'ENOENT' })
      else child.emit('close', code)
    })
    return child
  })
  const log = { error: jest.fn(), info: jest.fn(), warn: jest.fn() }
  const modules = {
    child_process: { spawn }, path,
    pg: { Pool: function () { this.end = end } },
    '../src/casino-connectors/sync/cli-args': { parseSyncArgs: () => ({ ok: true, value: { runId } }) },
    '../src/casino-connectors/sync/SyncRunStore': { SyncRunStore: function () { this.setSegmentationStatus = setSegmentationStatus } },
    '../src/casino-connectors/sync/runner': { EXIT: { SUCCESS: 0, FAILED: 1, USAGE: 2, SKIPPED: 3 } },
    '../src/lib/logger': { createLogger: () => log },
  }
  vm.runInNewContext(source, {
    require: name => { if (!(name in modules)) throw Error(`Unexpected dependency: ${name}`); return modules[name] },
    __dirname: path.dirname(scriptPath), process: mockProcess,
  }, { filename: scriptPath })
  await done
  await new Promise(resolve => setImmediate(resolve))
  return { spawn, setSegmentationStatus, exitCode: mockProcess.exitCode, runId }
}

describe('sync → segmentación (sin procesos ni DB reales)', () => {
  it('no modifica otra corrida ni segmenta cuando sync falla/rechaza el run_id', async () => {
    const r = await runFixture({ codes: [1] })
    expect(r.spawn).toHaveBeenCalledTimes(1)
    expect(r.setSegmentationStatus).not.toHaveBeenCalled()
    expect(r.exitCode).toBe(1)
  })
  it.each([false, new Error('synthetic persistence failure')])('no segmenta si no pudo registrar el inicio (%s)', async record => {
    const r = await runFixture({ record })
    expect(r.spawn).toHaveBeenCalledTimes(1)
    expect(r.exitCode).toBe(1)
    expect(r.setSegmentationStatus).toHaveBeenCalledTimes(1)
  })
  it('segmenta solo tras sync y registro exitosos, usando argv sin shell', async () => {
    const r = await runFixture()
    expect(r.spawn).toHaveBeenCalledTimes(2)
    expect(r.spawn.mock.calls[1][0]).toBe('/synthetic/node')
    expect(r.spawn.mock.calls[1][1]).toEqual([path.resolve(__dirname, '../../scripts/segmentar-casino-players.js')])
    expect(r.setSegmentationStatus.mock.calls.map(c => c[1])).toEqual(['running', 'success'])
    expect(r.exitCode).toBe(0)
  })
  it('registra y propaga un fallo de segmentación', async () => {
    const r = await runFixture({ codes: [0, 1] })
    expect(r.setSegmentationStatus.mock.calls.map(c => c[1])).toEqual(['running', 'failed'])
    expect(r.exitCode).toBe(1)
  })
  it('no segmenta ante error de arranque', async () => {
    const r = await runFixture({ spawnError: true })
    expect(r.spawn).toHaveBeenCalledTimes(1)
    expect(r.setSegmentationStatus).not.toHaveBeenCalled()
    expect(r.exitCode).toBe(1)
  })
})
