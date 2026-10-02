'use strict'

const { ZeusConnector } = require('../zeus/ZeusConnector')

/**
 * Connector for Bet30 (bet30.world).
 *
 * Bet30 is a skin of the Zeus backend — identical API contract:
 *   endpoint, response shape, auth headers, date handling.
 *
 * All behavior is inherited from ZeusConnector.
 * Differentiation is config-driven (name, baseUrl, credentials). In particular,
 * the Zeus-only bonus-as-deposit rule does not apply to Bet30.
 */
class Bet30Connector extends ZeusConnector {}

module.exports = { Bet30Connector }
