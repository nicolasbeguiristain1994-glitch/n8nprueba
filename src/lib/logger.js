'use strict'

const pino = require('pino')

// Default to 'silent' in test environments to keep test output clean.
// Override at any time with the LOG_LEVEL env var.
const DEFAULT_LEVEL = process.env.NODE_ENV === 'test' ? 'silent' : 'info'
const level         = process.env.LOG_LEVEL || DEFAULT_LEVEL

const root = pino({ level })

/**
 * Returns a child logger with the given context fields bound to every entry.
 * Use context to group logs by platform, component, or request — makes
 * filtering trivial in Loki / ELK / any JSON-aware log aggregator.
 *
 * @param {object} context  e.g. { platform: 'zeus' } | { component: 'sync' }
 * @returns {import('pino').Logger}
 *
 * @example
 * const log = createLogger({ platform: 'zeus', agent: 'betcoin' })
 * log.info({ txCount: 842 }, 'Sync completed')
 * // → { "level":30, "platform":"zeus", "agent":"betcoin", "txCount":842, "msg":"Sync completed" }
 */
function createLogger(context = {}) {
  return root.child(context)
}

module.exports = { createLogger, root }
