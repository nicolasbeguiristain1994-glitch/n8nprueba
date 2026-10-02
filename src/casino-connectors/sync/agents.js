'use strict'

/**
 * Agentes que se sincronizan por defecto en cada plataforma (cuando no se pasa
 * --agentes). Es la misma lista que usaba scripts/pipeline-diario.js.
 *
 * Antes el default era `SELECT DISTINCT agente FROM casino_players`, que no
 * distingue plataformas: pedía los agentes de Bet30 a la API de Zeus y viceversa.
 */
const SYNC_AGENTS = Object.freeze({
  zeus:  Object.freeze(['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']),
  bet30: Object.freeze(['btcuno', 'btcdos', 'zeus', 'zeusroyal', 'bigwin']),
})

/** Formato permitido para un nombre de agente (CLI y API). */
const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,50}$/

function defaultAgentsFor(platform) {
  return [...(SYNC_AGENTS[platform] ?? [])]
}

module.exports = { SYNC_AGENTS, AGENT_NAME_RE, defaultAgentsFor }
