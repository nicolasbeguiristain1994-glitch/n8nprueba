'use strict'

/**
 * Maps platform `type` values (from platforms.config.json) to the module that
 * implements them. Register new platforms here when adding support for a new
 * backend.
 *
 * Los módulos se cargan bajo demanda, no al importar este archivo. platforms.config.json
 * lista plataformas cuyo conector todavía no está escrito (ganamos, argenbet); con
 * `require` en el tope, esa sola ausencia tiraba abajo el módulo entero y dejaba sin
 * sincronizar también a Zeus y Bet30, que sí están implementados.
 */
const CONNECTOR_MAP = {
  zeus:     { path: './zeus/ZeusConnector',       export: 'ZeusConnector' },
  bet30:    { path: './bet30/Bet30Connector',     export: 'Bet30Connector' },
  ganamos:  { path: './ganamos/GanamosConnector', export: 'GanamosConnector' },
  argenbet: { path: './argenbet/ArgenBetConnector', export: 'ArgenBetConnector' },
}

function createConnector(platformName, pool) {
  const config = _loadPlatformConfig(platformName)

  const entry = CONNECTOR_MAP[config.type]
  if (!entry) {
    const registered = Object.keys(CONNECTOR_MAP).join(', ')
    throw new Error(
      `No connector registered for platform type "${config.type}". ` +
      `Registered types: ${registered}. ` +
      `Add it to CONNECTOR_MAP in src/casino-connectors/index.js`
    )
  }

  let ConnectorClass
  try {
    ConnectorClass = require(entry.path)[entry.export]
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(entry.path.replace('./', ''))) {
      throw new Error(
        `Platform type "${config.type}" is declared in platforms.config.json but its ` +
        `connector is not implemented yet (missing ${entry.path}).`
      )
    }
    throw err
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