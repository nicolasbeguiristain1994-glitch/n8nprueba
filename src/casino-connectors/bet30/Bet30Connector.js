'use strict'

const { ZeusConnector } = require('../zeus/ZeusConnector')

/**
 * Connector for Bet30 (bet30.world).
 *
 * Bet30 is a skin of the Zeus backend — identical API contract:
 *   endpoint, response shape, auth headers, date handling.
 *
 * All behavior is inherited from ZeusConnector.
 * Differentiation is purely config-driven (baseUrl, credentials).
 */
class Bet30Connector extends ZeusConnector {}

module.exports = { Bet30Connector }
