'use strict'

const {
  describeError, sanitizeErrorMessage, classifyError, SyncError, GENERIC_MESSAGES,
} = require('../../src/casino-connectors/sync/sanitize')
const { parseSyncArgs } = require('../../src/casino-connectors/sync/cli-args')

describe('describeError() — external errors never carry their own text', () => {
  const SECRET = 'synthetic phrase with spaces'
  const ALLOWED = [
    ...Object.values(GENERIC_MESSAGES),
    ...Object.values(GENERIC_MESSAGES).map(m => new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(HTTP \\d{3}\\)$`)),
    /^Error de base de datos \(SQLSTATE [0-9A-Z]{5}\)\.$/,
  ]
  const isAllowed = msg => ALLOWED.some(a => (a instanceof RegExp ? a.test(msg) : a === msg))

  it.each([
    ['JSON body',              new Error(`zeus auto-login failed: HTTP 400 — {"password":"${SECRET}"}`)],
    ['URL with credentials',   new Error(`fetch failed https://user:${SECRET}@host.invalid/x?token=abc`)],
    ['unlabeled free text',    new Error(`the answer is ${SECRET}`)],
    ['HTTP status property',   Object.assign(new Error(SECRET), { httpStatus: 502 })],
    ['Postgres detail values', Object.assign(new Error(`Key (u)=(${SECRET}) already exists`), { code: '23505' })],
    ['socket error',           Object.assign(new Error(`connect ${SECRET}`), { code: 'ECONNREFUSED' })],
    ['non-Error value',        `${SECRET}`],
    ['impostor with a domain code but not a SyncError', Object.assign(new Error(SECRET), { code: 'CURSOR_MISSING' })],
  ])('%s → allowlisted message only', (_label, err) => {
    const d = describeError(err)
    expect(d.message).not.toContain(SECRET)
    expect(isAllowed(d.message)).toBe(true)
  })

  it('keeps the controlled message of our own SyncError', () => {
    const d = describeError(new SyncError('CURSOR_MISSING', 'El agente betcoin no tiene cursor en zeus.'))
    expect(d).toEqual({ code: 'CURSOR_MISSING', message: 'El agente betcoin no tiene cursor en zeus.' })
  })

  it('adds the numeric HTTP status to generic messages', () => {
    expect(describeError(Object.assign(new Error('x'), { httpStatus: 401 })))
      .toEqual({ code: 'AUTH', message: `${GENERIC_MESSAGES.AUTH} (HTTP 401)` })
  })
})

describe('sanitizeErrorMessage() (defensa extra, solo para mensajes propios)', () => {
  it('removes URLs and truncates long messages', () => {
    expect(sanitizeErrorMessage('ver https://x.invalid/a?b=c')).toBe('ver [url]')
    expect(sanitizeErrorMessage(new Error('x '.repeat(600))).length).toBeLessThanOrEqual(501)
  })
})

describe('classifyError()', () => {
  it.each([
    [new SyncError('LEGACY_UNCLASSIFIED', 'x'), 'LEGACY_UNCLASSIFIED'],
    [new Error('zeus auto-login failed: HTTP 401 — nope'), 'AUTH'],
    [new Error('HTTP 403 (non-retriable client error)'), 'AUTH'],
    [new Error('HTTP 404 (non-retriable client error)'), 'HTTP_4XX'],
    [new Error('[zeus] All 4 attempts failed for agent "x": HTTP 503'), 'UPSTREAM'],
    [Object.assign(new Error('deadlock'), { code: '40P01' }), 'DB_40P01'],
    [Object.assign(new Error('nope'), { code: 'ECONNRESET' }), 'NETWORK'],
    [Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }), 'TIMEOUT'],
    [Object.assign(new Error('x'), { httpStatus: 403 }), 'AUTH'],
    [Object.assign(new Error('x'), { httpStatus: 429 }), 'HTTP_4XX'],
    [Object.assign(new Error('x'), { httpStatus: 500 }), 'UPSTREAM'],
    [Object.assign(new Error('x'), { code: 'EPIPE' }), 'NETWORK'],
    [new Error('???'), 'UNKNOWN'],
  ])('classifies %p as %s', (err, code) => {
    expect(classifyError(err)).toBe(code)
  })
})

describe('parseSyncArgs()', () => {
  const now = new Date('2026-09-13T15:00:00.000Z')
  const parse = argv => parseSyncArgs(argv, { now, defaultPlatform: 'zeus' })

  it('parses auto mode with bootstrap and run id', () => {
    const r = parse(['--platform=bet30', '--auto', '--bootstrap-desde=2026-08-01',
      '--run-id=11111111-2222-3333-4444-555555555555', '--trigger=api', '--agentes=btcuno, btcdos,btcuno'])
    expect(r).toEqual({ ok: true, value: expect.objectContaining({
      platform: 'bet30', mode: 'auto', bootstrapDesde: '2026-08-01',
      runId: '11111111-2222-3333-4444-555555555555', triggeredBy: 'api', agentes: ['btcuno', 'btcdos'],
    }) })
  })

  it('keeps the legacy default range (2020-01-01 → today ART) without --auto', () => {
    const r = parse([])
    expect(r.value).toMatchObject({ mode: 'range', desde: '2020-01-01', hasta: '2026-09-13' })
  })

  it.each([
    [['--auto', '--desde=2026-01-01'], /excluyentes/],
    [['--auto', '--hasta=2026-01-01'], /no admite --hasta/],
    [['--desde=2026-02-30'],           /--desde/],
    [['--desde=2026-09-10', '--hasta=2026-09-01'], /posterior/],
    [['--desde=2026-09-10', '--hasta=2026-09-20'], /futura/],
    [['--desde'],                      /--desde/],
    [['--agentes=a;rm -rf'],           /nombres inválidos/],
    [['--run-id=abc'],                 /UUID/],
    [['--concurrency=9'],              /concurrency/],
    [['--chunk-days=abc'],             /entero/],
    [['--frobnicate=1'],               /desconocido/],
    [['--bootstrap-desde=2026-01-01'], /solo aplica con --auto/],
    [['--platform=ZE US'],             /platform/],
  ])('rejects %p', (argv, message) => {
    const r = parse(argv)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(message)
  })
})
