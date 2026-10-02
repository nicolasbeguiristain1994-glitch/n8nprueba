'use strict'

/**
 * Guard para tests de integración: TEST_DATABASE_URL tiene que apuntar a un
 * Postgres LOCAL y nunca coincidir con DATABASE_URL.
 *
 * Considera todos los lugares de donde `pg` / libpq toman el host efectivo:
 *   - ?host= y ?hostaddr= en el query string (pisan al hostname de la URL;
 *     pueden venir repetidos o como lista separada por comas)
 *   - el hostname de la URL
 *   - PGHOST / PGHOSTADDR del entorno cuando la URL no trae host
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isLocalHost(h) {
  const host = String(h).trim().toLowerCase()
  if (!host) return false
  if (host.startsWith('/')) return true            // socket Unix local
  return LOCAL_HOSTS.has(host)
}

/**
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} hosts efectivos (para mensajes); lanza si alguno no es local
 */
function assertLocalTestUrl(url, env = process.env) {
  if (!url || typeof url !== 'string') throw new Error('TEST_DATABASE_URL vacía')
  if (env.DATABASE_URL && url.trim() === env.DATABASE_URL.trim()) {
    throw new Error('TEST_DATABASE_URL no puede ser igual a DATABASE_URL')
  }

  let u
  try {
    u = new URL(url)
  } catch {
    throw new Error('TEST_DATABASE_URL no es una URL válida')
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('TEST_DATABASE_URL debe usar postgres:// o postgresql://')
  }

  const fromQuery = [...u.searchParams.getAll('host'), ...u.searchParams.getAll('hostaddr')]
    .flatMap(v => v.split(','))
    .map(v => v.trim())
    .filter(Boolean)

  let hosts
  if (fromQuery.length) {
    hosts = fromQuery
  } else if (u.hostname) {
    hosts = [decodeURIComponent(u.hostname)]
  } else {
    hosts = [env.PGHOST, env.PGHOSTADDR].filter(Boolean).flatMap(v => v.split(',')).map(v => v.trim())
    if (!hosts.length) hosts = ['localhost']   // default de libpq
  }

  const remote = hosts.filter(h => !isLocalHost(h))
  if (remote.length) throw new Error('TEST_DATABASE_URL debe apuntar a un Postgres local')
  return hosts
}

module.exports = { assertLocalTestUrl, isLocalHost }
