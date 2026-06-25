'use strict'

const { ZeusConnector }     = require('./zeus/ZeusConnector')
const { Bet30Connector }    = require('./bet30/Bet30Connector')
const { GanamosConnector }  = require('./ganamos/GanamosConnector')
const { ArgenBetConnector } = require('./argenbet/ArgenBetConnector')

/**
 * Maps platform `type` values (from platforms.config.json) to their connector classes.
 * Register new platforms here when adding support for a new backend.
 */
const CONNECTOR_MAP = {
  zeus:     ZeusConnector,
  bet30:    Bet30Connector,
  ganamos:  GanamosConnector,
  argenbet: ArgenBetConnector,
}

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

function getDefaultPlatform() {
  const { defaultPlatform } = require('../config/platforms.config.json')
  if (!defaultPlatform) throw new Error('platforms.config.json is missing "defaultPlatform"')
  return defaultPlatform
}

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