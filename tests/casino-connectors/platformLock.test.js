'use strict'

const { acquirePlatformLock } = require('../../src/casino-connectors/shared/platformLock')

function makeClient({ locked = true, failUnlock = false } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] }
      if (sql.includes('pg_advisory_unlock')) {
        if (failUnlock) throw new Error('unlock failed')
        return { rows: [{}] }
      }
      throw new Error(`unexpected query: ${sql}`)
    }),
    release: jest.fn(),
  }
}

function makePool(client) {
  return { connect: jest.fn(async () => client) }
}

describe('acquirePlatformLock', () => {
  it('acquires the lock and releases cleanly on release()', async () => {
    const client = makeClient({ locked: true })
    const pool = makePool(client)

    const lock = await acquirePlatformLock(pool, 'zeus')
    expect(lock.acquired).toBe(true)
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'), ['casino-sync:zeus'])

    await lock.release()
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), ['casino-sync:zeus'])
    expect(client.release).toHaveBeenCalledWith() // clean release, no error arg
  })

  it('returns acquired:false and releases the borrowed client cleanly when another run holds the lock', async () => {
    const client = makeClient({ locked: false })
    const pool = makePool(client)

    const lock = await acquirePlatformLock(pool, 'zeus')
    expect(lock.acquired).toBe(false)
    expect(client.release).toHaveBeenCalledWith() // returned to the pool immediately, not held
  })

  it('destroys (does not cleanly release) the connection if unlock() fails', async () => {
    const client = makeClient({ locked: true, failUnlock: true })
    const pool = makePool(client)

    const lock = await acquirePlatformLock(pool, 'zeus')
    await lock.release()

    expect(client.release).toHaveBeenCalledWith(expect.any(Error)) // destroyed, not clean
  })

  it('release() is idempotent — calling it twice only unlocks once', async () => {
    const client = makeClient({ locked: true })
    const pool = makePool(client)

    const lock = await acquirePlatformLock(pool, 'zeus')
    await lock.release()
    await lock.release()

    const unlockCalls = client.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_unlock'))
    expect(unlockCalls).toHaveLength(1)
  })

  it('two different platforms use different lock keys (never contend with each other)', async () => {
    const clientA = makeClient({ locked: true })
    const clientB = makeClient({ locked: true })
    const poolA = makePool(clientA)
    const poolB = makePool(clientB)

    await acquirePlatformLock(poolA, 'zeus')
    await acquirePlatformLock(poolB, 'bet30')

    expect(clientA.query).toHaveBeenCalledWith(expect.any(String), ['casino-sync:zeus'])
    expect(clientB.query).toHaveBeenCalledWith(expect.any(String), ['casino-sync:bet30'])
  })
})
