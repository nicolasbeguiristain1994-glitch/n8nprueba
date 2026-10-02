'use strict'

/**
 * Persistencia del Centro de Monitoreo: corridas, resultados por agente/rango,
 * cursores y el lock por plataforma. Tablas de db/migrations/125.
 *
 * Todo mensaje de error que llega acá ya viene sanitizado por el runner.
 */

const os = require('os')

// Espacio de claves para pg_try_advisory_lock(ns, hashtext('casino_sync:<platform>')).
const PLATFORM_LOCK_NAMESPACE = 7125

/**
 * Condición para que un runner tome una fila existente con su run_id: tiene que
 * ser una pre-registración de la API que ningún runner tomó todavía
 * (instance_id NULL) y con exactamente los mismos parámetros. Cualquier otra
 * fila con ese run_id (activa, terminada, de otro runner o con otros parámetros)
 * no se toca.
 */
const ADOPTABLE_PRE_REGISTRATION = `
       casino_sync_runs.status        = 'running'
   AND casino_sync_runs.finished_at   IS NULL
   AND casino_sync_runs.instance_id   IS NULL
   AND casino_sync_runs.triggered_by  = EXCLUDED.triggered_by
   AND casino_sync_runs.platform      = EXCLUDED.platform
   AND casino_sync_runs.mode          = EXCLUDED.mode
   AND casino_sync_runs.requested_desde  IS NOT DISTINCT FROM EXCLUDED.requested_desde
   AND casino_sync_runs.requested_hasta  IS NOT DISTINCT FROM EXCLUDED.requested_hasta
   AND casino_sync_runs.requested_agents IS NOT DISTINCT FROM EXCLUDED.requested_agents`

class SyncRunStore {
  /**
   * @param {import('pg').Pool} pool
   * @param {{instanceId?: string}} [opts]  identifica al runner (nunca NULL: NULL
   *   significa "pre-registrada por la API, sin runner")
   */
  constructor(pool, { instanceId = `${os.hostname()}:${process.pid}` } = {}) {
    this.pool       = pool
    this.instanceId = instanceId
  }

  /**
   * Lock de sesión por plataforma sobre un cliente dedicado.
   *
   * Se prefiere a un lock con TTL: dura exactamente lo que dura la conexión.
   * Si el proceso muere, Postgres cierra la sesión y el lock se libera solo; no
   * hay que renovar nada ni adivinar cuánto tarda una carga histórica.
   *
   * Requiere conexión directa o pooler en modo sesión (un pooler transaccional
   * no mantiene locks de sesión).
   *
   * @returns {Promise<{acquired: boolean, release: () => Promise<void>}>}
   */
  async acquirePlatformLock(platform) {
    const client = await this.pool.connect()
    const key    = `casino_sync:${platform}`

    let acquired = false
    try {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok',
        [PLATFORM_LOCK_NAMESPACE, key],
      )
      acquired = rows[0]?.ok === true
    } catch (err) {
      client.release(err)
      throw err
    }

    if (!acquired) {
      client.release()
      return { acquired: false, release: async () => {} }
    }

    let released = false
    return {
      acquired: true,
      release: async () => {
        if (released) return
        released = true
        try {
          await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [PLATFORM_LOCK_NAMESPACE, key])
        } finally {
          // Se descarta la conexión en vez de devolverla al pool: si el unlock
          // falló, cerrar la sesión es lo único que garantiza soltar el lock.
          client.release(true)
        }
      },
    }
  }

  /**
   * Registra el inicio de la corrida.
   *
   * - run_id nuevo → inserta la fila con el instance_id de este runner.
   * - run_id pre-registrado por la API (instance_id NULL, mismos parámetros)
   *   → lo adopta.
   * - cualquier otro caso (corrida activa de otro runner, terminada o con otros
   *   parámetros) → devuelve false sin modificar la fila existente.
   */
  async startRun({ runId, platform, mode, triggeredBy, requestedDesde, requestedHasta, requestedAgents }) {
    const { rows } = await this.pool.query(
      `INSERT INTO casino_sync_runs
         (run_id, platform, mode, triggered_by, requested_desde, requested_hasta,
          requested_agents, status, started_at, heartbeat_at, instance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', NOW(), NOW(), $8)
       ON CONFLICT (run_id) DO UPDATE SET
         heartbeat_at = NOW(),
         instance_id  = EXCLUDED.instance_id
       WHERE ${ADOPTABLE_PRE_REGISTRATION}
       RETURNING run_id`,
      [runId, platform, mode, triggeredBy, requestedDesde, requestedHasta,
       requestedAgents, this.instanceId],
    )
    return rows.length > 0
  }

  /**
   * Registra una corrida que no llegó a ejecutarse (lock ocupado). Solo cierra
   * como skipped una pre-registración de la API sin runner; nunca una corrida
   * activa o terminada que comparta el run_id.
   *
   * @returns {Promise<boolean>} false si el run_id pertenece a otra corrida (no se modificó)
   */
  async recordSkippedRun({ runId, platform, mode, triggeredBy, requestedDesde, requestedHasta,
                           requestedAgents, errorCode, errorMessage }) {
    const { rows } = await this.pool.query(
      `INSERT INTO casino_sync_runs
         (run_id, platform, mode, triggered_by, requested_desde, requested_hasta, requested_agents,
          status, started_at, heartbeat_at, finished_at, error_code, error_message,
          segmentation_status, instance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'skipped', NOW(), NOW(), NOW(), $8, $9, 'skipped', $10)
       ON CONFLICT (run_id) DO UPDATE SET
         status              = 'skipped',
         finished_at         = NOW(),
         heartbeat_at        = NOW(),
         error_code          = EXCLUDED.error_code,
         error_message       = EXCLUDED.error_message,
         segmentation_status = 'skipped',
         instance_id         = EXCLUDED.instance_id
       WHERE ${ADOPTABLE_PRE_REGISTRATION}
       RETURNING run_id`,
      [runId, platform, mode, triggeredBy, requestedDesde, requestedHasta, requestedAgents,
       errorCode, errorMessage, this.instanceId],
    )
    return rows.length > 0
  }

  /**
   * Con el lock de la plataforma tomado, cualquier otra corrida `running` de esa
   * plataforma con heartbeat viejo está muerta: se cierra como fallida para que
   * no quede eternamente "en curso". Devuelve cuántas cerró.
   */
  async closeInterruptedRuns(platform, exceptRunId, staleMinutes) {
    const { rowCount } = await this.pool.query(
      `UPDATE casino_sync_runs
       SET status        = 'failed',
           finished_at   = NOW(),
           error_code    = 'INTERRUPTED',
           error_message = 'La corrida dejó de reportar heartbeat y no terminó; se cerró al iniciar otra corrida.',
           segmentation_status = CASE WHEN segmentation_status IN ('pending', 'running')
                                      THEN 'skipped' ELSE segmentation_status END
       WHERE platform = $1
         AND run_id  <> $2
         AND status   = 'running'
         AND heartbeat_at < NOW() - make_interval(mins => $3)`,
      [platform, exceptRunId, staleMinutes],
    )
    return rowCount ?? 0
  }

  async heartbeat(runId) {
    await this.pool.query(
      `UPDATE casino_sync_runs SET heartbeat_at = NOW()
       WHERE run_id = $1 AND status = 'running'`,
      [runId],
    )
  }

  /** Cierra la corrida con su estado final y contadores. */
  async finishRun(runId, { status, counters = {}, errorCode = null, errorMessage = null, segmentationStatus = null }) {
    const c = counters
    const { rowCount } = await this.pool.query(
      `UPDATE casino_sync_runs SET
         status             = $2,
         finished_at        = NOW(),
         heartbeat_at       = NOW(),
         agents_total       = $3,
         agents_ok          = $4,
         agents_failed      = $5,
         ranges_ok          = $6,
         ranges_failed      = $7,
         ranges_skipped     = $8,
         tx_fetched         = $9,
         tx_inserted        = $10,
         tx_without_id      = $11,
         players_recomputed = $12,
         error_code         = $13,
         error_message      = $14,
         -- Una corrida sin éxito no se segmenta: la segmentación pedida por la
         -- API queda 'skipped' acá mismo (la cierra quien es dueño de la corrida).
         segmentation_status = CASE
           WHEN $2 <> 'success' AND segmentation_status = 'pending' THEN 'skipped'
           ELSE COALESCE($15, segmentation_status)
         END,
         segmentation_finished_at = CASE
           WHEN $2 <> 'success' AND segmentation_status = 'pending' THEN NOW()
           ELSE segmentation_finished_at
         END
       WHERE run_id = $1 AND status = 'running'`,
      [runId, status,
       c.agentsTotal ?? 0, c.agentsOk ?? 0, c.agentsFailed ?? 0,
       c.rangesOk ?? 0, c.rangesFailed ?? 0, c.rangesSkipped ?? 0,
       c.txFetched ?? 0, c.txInserted ?? 0, c.txWithoutId ?? 0, c.playersRecomputed ?? 0,
       errorCode, errorMessage, segmentationStatus],
    )
    if (!rowCount) {
      throw Object.assign(new Error('La corrida ya no estaba en estado running al cerrarla'), { code: 'RUN_STATE_LOST' })
    }
  }

  /**
   * Estado de la segmentación posterior a una corrida EXITOSA. Solo avanza
   * pending → running → success|failed; no toca corridas sin éxito ni pisa un
   * estado final. Devuelve false si no se actualizó nada.
   */
  async setSegmentationStatus(runId, status) {
    // 'not_requested' = la cadena se lanzó a mano (sin pre-registro de la API).
    const from = status === 'running' ? ['pending', 'not_requested'] : ['running']
    const { rowCount } = await this.pool.query(
      `UPDATE casino_sync_runs
       SET segmentation_status      = $2,
           segmentation_finished_at = CASE WHEN $2 IN ('success', 'failed') THEN NOW() ELSE NULL END
       WHERE run_id = $1
         AND status = 'success'
         AND segmentation_status = ANY($3::text[])`,
      [runId, status, from],
    )
    return (rowCount ?? 0) > 0
  }

  /** Cursor actual. `db` puede ser el pool o un client dentro de transacción. */
  async getCursor(platform, agente, db = this.pool, { forUpdate = false } = {}) {
    const { rows } = await db.query(
      `SELECT covered_from::text AS covered_from, covered_through::text AS covered_through
       FROM casino_sync_cursors
       WHERE platform = $1 AND agente = $2
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [platform, agente],
    )
    if (!rows.length) return null
    return { coveredFrom: rows[0].covered_from, coveredThrough: rows[0].covered_through }
  }

  async saveCursor(db, platform, agente, cursor, runId) {
    await db.query(
      `INSERT INTO casino_sync_cursors (platform, agente, covered_from, covered_through, last_run_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (platform, agente) DO UPDATE SET
         covered_from    = EXCLUDED.covered_from,
         covered_through = EXCLUDED.covered_through,
         last_run_id     = EXCLUDED.last_run_id,
         updated_at      = NOW()`,
      [platform, agente, cursor.coveredFrom, cursor.coveredThrough, runId],
    )
  }

  /**
   * Filas históricas sin plataforma del agente dentro del rango. Si hay alguna,
   * escribir filas nuevas con plataforma podría duplicar esos mismos
   * movimientos (distinta clave única): el runner corta en ese caso.
   */
  async countUnclassifiedLegacy(db, agente, desde, hasta) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n
       FROM casino_transactions
       WHERE platform IS NULL
         AND LOWER(agente) = LOWER($1)
         AND fecha BETWEEN $2::date AND $3::date`,
      [agente, desde, hasta],
    )
    return rows[0]?.n ?? 0
  }

  /** Registra el resultado de un (agente, rango). `db`: pool o client en transacción. */
  async recordRange(db, r) {
    await db.query(
      `INSERT INTO casino_sync_agent_ranges
         (run_id, platform, agente, desde, hasta, status, coverage, cursor_moved, fetch_started_at,
          tx_fetched, tx_normalized, tx_inserted, tx_updated, tx_without_id, tx_duplicate_ids,
          tx_collapsed_without_id, tx_invalid, tx_excluded, players_recomputed, error_code, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [r.runId, r.platform, r.agente, r.desde ?? null, r.hasta ?? null, r.status,
       r.coverage ?? null, r.cursorMoved ?? false, r.fetchStartedAt ?? null,
       r.txFetched ?? 0, r.txNormalized ?? 0, r.txInserted ?? 0, r.txUpdated ?? 0,
       r.txWithoutId ?? 0, r.txDuplicateIds ?? 0, r.txCollapsedWithoutId ?? 0,
       r.txInvalid ?? 0, r.txExcluded ?? 0,
       r.playersRecomputed ?? 0, r.errorCode ?? null, r.errorMessage ?? null],
    )
  }
}

module.exports = { SyncRunStore, PLATFORM_LOCK_NAMESPACE }
