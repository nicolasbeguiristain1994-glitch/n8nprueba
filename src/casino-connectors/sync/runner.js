'use strict'

const crypto = require('crypto')
const pLimit = require('p-limit')

const { argToday, buildDateChunks } = require('./dates')
const { advanceCursor, resolveAutoRange } = require('./cursor')
const { describeError, SyncError } = require('./sanitize')
const { SyncRunStore } = require('./SyncRunStore')
const { defaultAgentsFor } = require('./agents')
const { isCasinoSyncPaused, CASINO_SYNC_PAUSED_CODE, CASINO_SYNC_PAUSED_MESSAGE } = require('./maintenance')

/**
 * Códigos de salida del proceso de sync.
 *   0  success               todos los agentes y rangos OK
 *   1  failed / partial      algún agente falló, o falló la persistencia
 *   2  uso inválido           argumentos (lo usa la CLI, no el runner)
 *   3  skipped               otra corrida de la misma plataforma tiene el lock
 *
 * Cualquier valor ≠ 0 corta la cadena sync → segmentación.
 */
const EXIT = Object.freeze({ SUCCESS: 0, FAILED: 1, USAGE: 2, SKIPPED: 3 })

const DEFAULTS = Object.freeze({
  chunkDays:           30,
  concurrency:         1,
  overlapDays:         1,
  heartbeatMs:         30_000,
  staleMinutes:        10,
  politenessMs:        400,
})

/**
 * Ejecuta una corrida de sync de una plataforma.
 *
 * @param {object} opts
 * @param {string}   opts.platform
 * @param {'auto'|'range'} opts.mode
 * @param {string}   [opts.desde]           requerido en modo range
 * @param {string}   [opts.hasta]           default: hoy (hora Argentina)
 * @param {string[]} [opts.agentes]         default: agents.js
 * @param {string}   [opts.runId]           default: uuid nuevo (la API lo pre-registra)
 * @param {'cli'|'api'|'pipeline'} [opts.triggeredBy]
 * @param {string}   [opts.bootstrapDesde]  inicio para agentes sin cursor en modo auto
 * @param {number}   [opts.chunkDays]
 * @param {number}   [opts.concurrency]
 * @param {number}   [opts.overlapDays]
 * @param {AbortSignal} [opts.signal]       SIGTERM/SIGINT: deja de tomar rangos nuevos
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {(platform: string, pool: object) => object} deps.createConnector
 * @param {object}   deps.log               logger pino
 * @param {SyncRunStore} [deps.store]
 * @param {() => Date} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {Record<string, string|undefined>} [deps.env]  default: process.env (pausa operativa)
 *
 * @returns {Promise<{runId: string|null, status: string, exitCode: number, counters: object, errorCode?: string, message?: string}>}
 */
async function runSync(opts, deps) {
  const cfg   = { ...DEFAULTS, ...pickDefined(opts) }
  const log   = deps.log

  // ── Pausa operativa ─────────────────────────────────────────────────────────
  // Antes de crear el store, tomar el lock, consultar la base o autenticarse con
  // el proveedor: una corrida pausada no toca nada ni queda registrada.
  if (isCasinoSyncPaused(deps.env ?? process.env)) {
    log.warn({ platform: cfg.platform, errorCode: CASINO_SYNC_PAUSED_CODE }, CASINO_SYNC_PAUSED_MESSAGE)
    return {
      runId:     cfg.runId ?? null,
      status:    'failed',
      exitCode:  EXIT.FAILED,
      counters:  emptyCounters(),
      errorCode: CASINO_SYNC_PAUSED_CODE,
      message:   CASINO_SYNC_PAUSED_MESSAGE,
    }
  }

  const now   = deps.now   ?? (() => new Date())
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const store = deps.store ?? new SyncRunStore(deps.pool)

  const runId    = cfg.runId ?? crypto.randomUUID()
  const platform = cfg.platform
  const runMeta  = {
    runId,
    platform,
    mode:            cfg.mode,
    triggeredBy:     cfg.triggeredBy ?? 'cli',
    requestedDesde:  cfg.mode === 'range' ? cfg.desde : null,
    requestedHasta:  cfg.mode === 'range' ? (cfg.hasta ?? null) : null,
    requestedAgents: cfg.agentes ?? null,
  }

  // ── Lock de plataforma ──────────────────────────────────────────────────────
  let lock
  try {
    lock = await store.acquirePlatformLock(platform)
  } catch (err) {
    const d = describeError(err)
    log.error({ runId, errorCode: d.code, err: d.message, alert: true },
      'No se pudo tomar el lock de plataforma — la corrida no se ejecutó ni se registró')
    return { runId, status: 'failed', exitCode: EXIT.FAILED, counters: emptyCounters(), errorCode: 'DB_UNAVAILABLE' }
  }

  if (!lock.acquired) {
    const message = `Ya hay una corrida de ${platform} en curso; esta no se ejecutó.`
    let recorded
    try {
      recorded = await store.recordSkippedRun({ ...runMeta, errorCode: 'LOCK_BUSY', errorMessage: message })
    } catch (err) {
      const d = describeError(err)
      log.error({ runId, errorCode: d.code, err: d.message, alert: true }, 'No se pudo registrar la corrida omitida')
      return { runId, status: 'skipped', exitCode: EXIT.SKIPPED, counters: emptyCounters(), errorCode: 'LOCK_BUSY' }
    }
    if (recorded === false) {
      // El run_id pertenece a otra corrida (activa o terminada): no se toca.
      log.error({ runId, platform, alert: true }, 'run_id reutilizado — la corrida original no se modificó')
      return { runId, status: 'failed', exitCode: EXIT.FAILED, counters: emptyCounters(), errorCode: 'RUN_ID_REUSED' }
    }
    log.warn({ runId, platform }, message)
    return { runId, status: 'skipped', exitCode: EXIT.SKIPPED, counters: emptyCounters(), errorCode: 'LOCK_BUSY' }
  }

  const counters = emptyCounters()
  const shared   = { halted: false, fatal: null }
  let heartbeatTimer = null
  let started = false

  try {
    // ── Registro de inicio ──────────────────────────────────────────────────
    const adopted = await store.startRun(runMeta)
    if (!adopted) {
      throw new SyncError('RUN_ID_REUSED',
        'El run_id ya pertenece a otra corrida (activa, terminada o con otros parámetros); no se modificó.')
    }
    started = true

    const closed = await store.closeInterruptedRuns(platform, runId, cfg.staleMinutes)
    if (closed) log.warn({ runId, closed, alert: true }, 'Corridas interrumpidas cerradas como fallidas')

    heartbeatTimer = setInterval(() => {
      store.heartbeat(runId).catch(err => {
        const d = describeError(err)
        log.warn({ runId, errorCode: d.code }, 'Heartbeat falló')
      })
    }, cfg.heartbeatMs)
    heartbeatTimer.unref?.()

    // ── Conector y autenticación ────────────────────────────────────────────
    let connector
    try {
      connector = deps.createConnector(platform, deps.pool)
    } catch {
      throw new SyncError('CONNECTOR_UNAVAILABLE',
        `No hay conector disponible para ${platform} (no implementado o configuración incompleta).`)
    }
    await connector.authenticate()

    // ── Agentes ─────────────────────────────────────────────────────────────
    const agentes = cfg.agentes?.length ? cfg.agentes : defaultAgentsFor(platform)
    if (!agentes.length) {
      throw new SyncError('NO_AGENTS', `No hay agentes configurados para ${platform}; pasar --agentes.`)
    }
    counters.agentsTotal = agentes.length

    const today = argToday(now())
    const limit = pLimit(Math.max(1, cfg.concurrency))

    // Cada tarea captura su propio error: se espera a TODAS antes de seguir, así
    // el lock no se libera mientras otra tarea todavía está escribiendo.
    const settled = await Promise.allSettled(agentes.map(agente => limit(async () => {
      if (shared.halted) return false   // persistencia perdida: no arrancar agentes nuevos
      try {
        return await syncOneAgent({ agente, today, cfg, connector, store, log, runId, platform, sleep, counters, shared })
      } catch (err) {
        // Solo escapa de syncOneAgent una falla de persistencia del registro.
        if (!shared.fatal) shared.fatal = err
        shared.halted = true
        return false
      }
    })))

    const results = settled.map(s => s.status === 'fulfilled' && s.value === true)
    counters.agentsOk     = results.filter(Boolean).length
    counters.agentsFailed = results.length - counters.agentsOk

    if (shared.fatal) {
      const d = describeError(shared.fatal)
      throw new SyncError('PERSISTENCE_FAILED',
        `No se pudo registrar el resultado de un agente (${d.code}); la corrida se detuvo sin iniciar tramos nuevos.`)
    }

    const interrupted = cfg.signal?.aborted === true
    const byAgents    = counters.agentsFailed === 0
      ? 'success'
      : counters.agentsOk === 0 ? 'failed' : 'partial'
    // Una señal de parada nunca se reporta como éxito, aunque no haya cortado nada.
    const finalStatus = interrupted && byAgents === 'success' ? 'partial' : byAgents

    const errorCode = interrupted ? 'INTERRUPTED'
      : finalStatus === 'success' ? null : 'AGENT_FAILURES'
    const errorMessage = interrupted
      ? 'La corrida recibió una señal de parada antes de terminar.'
      : finalStatus === 'success' ? null
        : `${counters.agentsFailed} de ${counters.agentsTotal} agentes con fallos; ver resultados por agente.`

    await store.finishRun(runId, { status: finalStatus, counters, errorCode, errorMessage })

    const logFn = finalStatus === 'success' ? log.info.bind(log) : log.error.bind(log)
    logFn({ runId, platform, status: finalStatus, ...counters, alert: finalStatus !== 'success' }, 'Sync run finished')

    return {
      runId,
      status:   finalStatus,
      exitCode: finalStatus === 'success' ? EXIT.SUCCESS : EXIT.FAILED,
      counters,
      errorCode: errorCode ?? undefined,
    }
  } catch (err) {
    const d = describeError(err)
    log.error({ runId, platform, errorCode: d.code, err: d.message, alert: true }, 'Sync run failed')

    if (started) {
      try {
        await store.finishRun(runId, { status: 'failed', counters, errorCode: d.code, errorMessage: d.message })
      } catch (persistErr) {
        const p = describeError(persistErr)
        log.error({ runId, errorCode: p.code, alert: true },
          'No se pudo registrar el fallo de la corrida; quedará como interrumpida (stale)')
      }
    }

    return { runId, status: 'failed', exitCode: EXIT.FAILED, counters, errorCode: d.code }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    try {
      await lock.release()
    } catch (err) {
      log.warn({ runId, errorCode: describeError(err).code }, 'Error al liberar el lock (la conexión se descartó)')
    }
  }
}

/**
 * Sincroniza un agente: resuelve su rango, lo parte en tramos y los procesa en
 * orden. Un tramo fallido corta los siguientes (quedan como skipped): procesarlos
 * dejaría datos más nuevos detrás de un hueco que el cursor no puede cruzar.
 *
 * Los fallos de un tramo se registran y el agente devuelve false. Solo lanza si
 * no puede registrar un resultado (persistencia perdida); el runner lo trata como
 * fatal y deja de iniciar tramos nuevos en todos los agentes.
 *
 * @returns {Promise<boolean>} true si todos los tramos terminaron OK
 */
async function syncOneAgent({ agente, today, cfg, connector, store, log, runId, platform, sleep, counters, shared }) {
  const recordFailure = async (range, err) => {
    const d = describeError(err)
    counters.rangesFailed++
    log.error({ runId, agent: agente, ...range, errorCode: d.code, err: d.message, alert: true }, 'Agent range failed')
    await store.recordRange(store.pool, {
      runId, platform, agente, ...range, status: 'failed', errorCode: d.code, errorMessage: d.message,
    })
  }

  // ── Rango del agente ──────────────────────────────────────────────────────
  let desde
  let hasta
  if (cfg.mode === 'range') {
    desde = cfg.desde
    hasta = cfg.hasta ?? today
  } else {
    let cursor
    try {
      cursor = await store.getCursor(platform, agente)
    } catch (err) {
      await recordFailure({}, err)
      return false
    }
    const range = resolveAutoRange(cursor, {
      today,
      overlapDays:    cfg.overlapDays,
      bootstrapDesde: cfg.bootstrapDesde ?? null,
    })
    if (range.error) {
      await recordFailure({}, new SyncError('CURSOR_MISSING',
        `El agente ${agente} no tiene cursor en ${platform}: correr una sincronización por rango ` +
        '(--desde) o usar --bootstrap-desde para establecerlo.'))
      return false
    }
    desde = range.desde
    hasta = range.hasta
  }

  const chunks = buildDateChunks(desde, hasta, Math.max(1, cfg.chunkDays))
  let ok = true

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]

    // Persistencia perdida en otra tarea: no iniciar tramos nuevos ni intentar
    // más escrituras de registro.
    if (shared.halted) {
      counters.rangesSkipped += chunks.length - i
      return false
    }

    if (!ok || cfg.signal?.aborted) {
      counters.rangesSkipped++
      await store.recordRange(store.pool, {
        runId, platform, agente, ...chunk, status: 'skipped',
        errorCode:    cfg.signal?.aborted ? 'INTERRUPTED' : 'PREVIOUS_CHUNK_FAILED',
        errorMessage: cfg.signal?.aborted
          ? 'No se procesó: la corrida recibió una señal de parada.'
          : 'No se procesó: un tramo anterior del mismo agente falló.',
      })
      ok = false
      continue
    }

    try {
      // Fail-closed: filas históricas sin plataforma en el rango → no escribir.
      const assertClassified = async db => {
        const n = await store.countUnclassifiedLegacy(db, agente, chunk.desde, chunk.hasta)
        if (n > 0) {
          throw new SyncError('LEGACY_UNCLASSIFIED',
            `${n} filas históricas sin plataforma para el agente ${agente} entre ${chunk.desde} y ` +
            `${chunk.hasta}. Clasificarlas antes de sincronizar (ver runbook del Centro de Monitoreo).`)
        }
      }

      // Chequeo previo para no pegarle a la API en vano; se repite dentro de la
      // transacción antes de escribir.
      await assertClassified(store.pool)

      const summary = await connector.syncAgent(agente, chunk.desde, chunk.hasta, {
        beforeWrite: assertClassified,
        afterWrite: async (client, s) => {
          const current = await store.getCursor(platform, agente, client, { forUpdate: true })
          const next    = advanceCursor(current, { ...chunk, fetchStartedAt: s.fetchStartedAt })
          if (next.moved) await store.saveCursor(client, platform, agente, next.cursor, runId)

          await store.recordRange(client, {
            runId, platform, agente, ...chunk,
            status:               'success',
            coverage:             s.coverage,
            cursorMoved:          next.moved,
            fetchStartedAt:       s.fetchStartedAt,
            txFetched:            s.txCount,
            txNormalized:         s.txNormalized,
            txInserted:           s.insertedTxCount,
            txUpdated:            s.updatedTxCount,
            txWithoutId:          s.txWithoutId,
            txDuplicateIds:       s.txDuplicateIds,
            txCollapsedWithoutId: s.txCollapsedWithoutId,
            txInvalid:            s.txInvalid,
            txExcluded:           s.txExcluded,
            playersRecomputed:    s.playerCount,
          })
        },
      })

      counters.rangesOk++
      counters.txFetched         += summary.txCount
      counters.txInserted        += summary.insertedTxCount
      counters.txWithoutId       += summary.txWithoutId
      counters.playersRecomputed += summary.playerCount

      if (summary.coverage === 'limited') {
        log.warn({ runId, agent: agente, ...chunk, txWithoutId: summary.txWithoutId,
          txCollapsedWithoutId: summary.txCollapsedWithoutId, txInvalid: summary.txInvalid, alert: true },
          'Cobertura limitada: movimientos sin ID o filas no interpretables')
      }
    } catch (err) {
      ok = false
      // Si registrar el fallo también falla, lanza: persistencia perdida.
      await recordFailure(chunk, err)
    } finally {
      if (cfg.politenessMs > 0) await sleep(cfg.politenessMs)
    }
  }

  return ok
}

function emptyCounters() {
  return {
    agentsTotal: 0, agentsOk: 0, agentsFailed: 0,
    rangesOk: 0, rangesFailed: 0, rangesSkipped: 0,
    txFetched: 0, txInserted: 0, txWithoutId: 0, playersRecomputed: 0,
  }
}

function pickDefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null))
}

module.exports = { runSync, EXIT, DEFAULTS }
