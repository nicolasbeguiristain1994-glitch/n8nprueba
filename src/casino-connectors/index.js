'use strict'

const { ZeusConnector }  = require('./zeus/ZeusConnector')
const { Bet30Connector } = require('./bet30/Bet30Connector')

/**
 * Maps platform `type` values (from platforms.config.json) to their connector classes.
 * Register new platforms here when adding support for a new backend.
 */
const CONNECTOR_MAP = {
  zeus:  ZeusConnector,
  bet30: Bet30Connector,
}

/**
 * Factory: loads the platform config and returns the correct connector instance.
 *
 * @param {string}            platformName  Must match a `name` in platforms.config.json
 * @param {import('pg').Pool} pool          Shared PG connection pool
 * @returns {import('./base/BaseCasinoConnector').BaseCasinoConnector}
 */
function createConnector(platformName, pool) {
  const config = _loadPlatformConfig(platformName)

  const ConnectorClass = CONNECTOR_MAP[config.type]
  if (!ConnectorClass) {
    const registered = Object.keys(CONNECTOR_MAP).join(', ')
    throw new Error(
      `No connector registered for platform type "${config.type}". ` +
      `Registered types: ${registered}. ` +
      `Add it to CONNECTOR_MAP in src/casino-connectors/index.js`
    )
  }

  return new ConnectorClass(config, pool)
}

/**
 * Returns the default platform name defined in platforms.config.json.
 * @returns {string}
 */
function getDefaultPlatform() {
  const { defaultPlatform } = require('../config/platforms.config.json')
  if (!defaultPlatform) throw new Error('platforms.config.json is missing "defaultPlatform"')
  return defaultPlatform
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _loadPlatformConfig(platformName) {
  const { platforms } = require('../config/platforms.config.json')

  const config = platforms.find(p => p.name === platformName)
  if (!config) {
    const available = platforms.map(p => p.name).join(', ')
    throw new Error(
      `Unknown platform "${platformName}". Available platforms: ${available}`
    )
  }

  return config
}

module.exports = { createConnector, getDefaultPlatform }
