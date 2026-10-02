'use strict'

// Sin base de datos: solo valida el guard que usa sync-integration.pg.test.js.
const { assertLocalTestUrl } = require('../helpers/local-db-guard')

describe('assertLocalTestUrl()', () => {
  const env = {}

  it.each([
    'postgresql://localhost:5432/wa_test',
    'postgresql://127.0.0.1/wa_test',
    'postgresql://[::1]:5432/wa_test',
    'postgresql:///wa_test?host=/tmp',
    'postgresql://localhost/wa_test?host=/var/run/postgresql',
    'postgres://u:p@localhost/wa_test?host=localhost,127.0.0.1',
    'postgresql:///wa_test',
  ])('accepts local %s', url => {
    expect(() => assertLocalTestUrl(url, env)).not.toThrow()
  })

  it.each([
    'postgresql://db.example.com/wa',
    'postgresql://localhost/wa?host=db.example.com',
    'postgresql://localhost/wa?host=/tmp&host=db.example.com',
    'postgresql://localhost/wa?host=localhost,db.example.com',
    'postgresql://localhost/wa?hostaddr=10.0.0.5',
    'mysql://localhost/wa',
    'no es url',
  ])('rejects %s', url => {
    expect(() => assertLocalTestUrl(url, env)).toThrow()
  })

  it('rejects an URL without host when PGHOST points to a remote server', () => {
    expect(() => assertLocalTestUrl('postgresql:///wa', { PGHOST: 'db.example.com' })).toThrow(/local/)
  })

  it('rejects TEST_DATABASE_URL equal to DATABASE_URL, even if local', () => {
    const url = 'postgresql://localhost/wa'
    expect(() => assertLocalTestUrl(url, { DATABASE_URL: url })).toThrow(/DATABASE_URL/)
  })
})
