import { PRIORITY_BUSY_SQL, PRIORITY_BATCH_JOINS } from './broadcasts'
import { Client } from 'pg'
import { priorityAccess, type PriorityAccess } from './access'
import { getLongRunningClient, query } from '@/lib/db'
import type {
  ContactMetricsRow,
  ContactPriorityScore,
  PaginatedResult,
  PriorityFilters,
  PrioritizedContact,
  RecomputeRunRecord,
} from './types'
import type { ReactivationSegment, ValueTier } from './config'

// ── Tipos internos (mapeo raw de pg → TS) ─────────────────────────────────────

interface MetricsDbRow {
  contact_id:           string
  phone_number:         string
  first_name:           string | null
  last_name:            string | null
  status:               string
  segment:              string | null
  last_deposit_at:      Date | null
  total_deposits:       string
  total_deposit_amount: string | null
  last_deposit_amount:  string | null
  do_not_contact:       boolean
  opt_in_marketing:     boolean
  deleted_at:           Date | null
}

interface PrioritizedDbRow {
  id:                      string
  phone_number:            string
  first_name:              string | null
  last_name:               string | null
  segment:                 string | null
  platforms:               string[]
  panel:                   string | null
  last_deposit_at:         Date | null
  total_deposit_amount:    string | null
  priority_score:          string
  reactivation_segment:    string | null
  value_tier:              string
  days_inactive:           string | null
  days_since_last_message: string | null
  is_broadcasted:          boolean
  broadcasted_at:          Date | null
  broadcasted_by:          string | null
  broadcast_state:         string | null
  broadcast_busy:          boolean
  ltv_score:               string | null
  ltv_tier:                string | null
}

interface LtvDbRow {
  contact_id: string
  ltv_score:  string
  ltv_tier:   string
}

interface CountRow { total: string }

// ── Repository ────────────────────────────────────────────────────────────────

export class UserPrioritizationRepository {
  constructor(private readonly client?: Client) {}
  private prepared = false
  private query: typeof query = async (sql, params) => this.client
    ? (await this.client.query(sql, params)).rows
    : query(sql, params)

  async withRecomputeSession<T>(work: (repo: UserPrioritizationRepository) => Promise<T>): Promise<T> {
    const client = await getLongRunningClient()
    try { return await work(new UserPrioritizationRepository(client)) }
    finally { await client.query('ROLLBACK').catch(() => undefined); await client.end() }
  }

  async prepareMetrics(): Promise<void> {
    if (!this.client) throw new Error('Recompute requires a dedicated transaction')
    await this.client.query('BEGIN')
    this.prepared = true
    await this.client.query(`CREATE TEMP TABLE priority_links ON COMMIT DROP AS
      SELECT DISTINCT contact_id, platform, username_lower FROM casino_contact_account_links`)
    await this.client.query(`CREATE INDEX ON priority_links(contact_id); ANALYZE priority_links`)
    await this.client.query(`
      CREATE TEMP TABLE priority_movements ON COMMIT DROP AS
      WITH movements AS MATERIALIZED (
        SELECT platform, lower(username) username_lower, max(fecha) last_movement
        FROM casino_transactions WHERE tipo IN ('carga','retiro') AND platform IN ('zeus','bet30','ganamos','argenbet') AND fecha <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
        GROUP BY platform, lower(username)
      )
      SELECT l.contact_id, (max(t.last_movement)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') last_movement
      FROM priority_links l JOIN movements t USING(platform,username_lower) GROUP BY l.contact_id`)
    await this.client.query(`      CREATE UNIQUE INDEX ON priority_movements(contact_id); ANALYZE priority_movements;
      CREATE TEMP TABLE priority_ltv(contact_id uuid, ltv_score int, ltv_tier text) ON COMMIT DROP;
      CREATE UNIQUE INDEX ON priority_ltv(contact_id)`)
    const [ltv] = await this.query<{ available: boolean }>("SELECT to_regclass('player_ltv') IS NOT NULL AS available")
    if (ltv.available) await this.client.query(`INSERT INTO priority_ltv
      SELECT DISTINCT ON (l.contact_id) l.contact_id, pl.ltv_score, pl.tier_ltv
      FROM priority_links l JOIN casino_players cp
        ON cp.username_lower=l.username_lower AND cp.platform IS NOT DISTINCT FROM l.platform
      JOIN player_ltv pl ON pl.casino_player_id=cp.id
      ORDER BY l.contact_id, pl.ltv_score DESC NULLS LAST`)

  }

  /**
   * Carga métricas crudas de contacts en batches.
   * Incluye columnas monetarias (NULL mientras no estén importadas).
   */
  /**
   * Carga métricas crudas de contacts en batches usando keyset pagination.
   * afterId es el último contact_id procesado; omitirlo inicia desde el principio.
   * Evita el drift de OFFSET cuando se insertan filas durante el recompute.
   */
  async fetchContactMetrics(limit: number, afterId?: string): Promise<ContactMetricsRow[]> {
    const sql = `
      SELECT
        c.id                   AS contact_id,
        c.phone_number,
        c.first_name,
        c.last_name,
        c.status,
        c.segment,
        ${this.prepared ? 'GREATEST(c.last_deposit_at, m.last_movement)' : 'c.last_deposit_at'} AS last_deposit_at,
        c.total_deposits,
        c.total_deposit_amount,
        c.last_deposit_amount,
        (c.do_not_contact OR EXISTS (SELECT 1 FROM blacklist b WHERE b.phone_number_normalized IN (c.phone_number,regexp_replace(c.phone_number,'[^0-9]','','g')) AND b.removed_at IS NULL)) AS do_not_contact,
        c.opt_in_marketing,
        c.deleted_at
      FROM contacts c
      ${this.prepared ? 'LEFT JOIN priority_movements m ON m.contact_id=c.id' : ''}
      WHERE c.phone_number IS NOT NULL
        AND c.phone_number <> ''
        ${afterId ? 'AND c.id > $2' : ''}
      ORDER BY c.id
      LIMIT $1
    `
    const params: unknown[] = afterId ? [limit, afterId] : [limit]
    const rows = await this.query<MetricsDbRow>(sql, params)
    return rows.map(mapMetrics)
  }

  async fetchContactById(contactId: string): Promise<ContactMetricsRow | null> {
    const sql = `
      SELECT
        c.id                   AS contact_id,
        c.phone_number,
        c.first_name,
        c.last_name,
        c.status,
        c.segment,
        c.last_deposit_at,
        c.total_deposits,
        c.total_deposit_amount,
        c.last_deposit_amount,
        c.do_not_contact,
        c.opt_in_marketing,
        c.deleted_at
      FROM contacts c
      WHERE c.id = $1
    `
    const rows = await this.query<MetricsDbRow>(sql, [contactId])
    return rows[0] ? mapMetrics(rows[0]) : null
  }

  /**
   * Retorna un mapa contactId → días desde el último mensaje enviado.
   * Contactos sin historial de mensajes no aparecen (caller recibe null).
   */
  async getLastMessagedDaysMap(contactIds: string[]): Promise<Map<string, number>> {
    if (contactIds.length === 0) return new Map()

    const sql = `
      SELECT
        contact_id,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(sent_at))) / 86400)::int AS days_ago
      FROM contact_send_history
      WHERE contact_id = ANY($1)
      GROUP BY contact_id
    `
    const rows = await this.query<{ contact_id: string; days_ago: number }>(sql, [contactIds])
    return new Map(rows.map(r => [r.contact_id, r.days_ago]))
  }

  /**
   * Persiste scores de forma idempotente via UNNEST bulk UPSERT.
   * runId identifica la corrida de recompute y se almacena en cada fila.
   * Un único round-trip a la DB por batch independientemente del tamaño.
   */
  async upsertScores(
    scores: Omit<ContactPriorityScore, 'id' | 'runId'>[],
    runId?: string,
  ): Promise<void> {
    if (scores.length === 0) return

    const sql = `
      INSERT INTO contact_priority_scores (
        contact_id,
        priority_score,
        reactivation_segment,
        value_tier,
        value_score,
        urgency_score,
        days_inactive,
        deposit_segment,
        total_deposit_amount,
        is_eligible,
        skip_reasons,
        run_id,
        computed_at,
        ltv_score,
        ltv_tier
      )
      SELECT
        t.contact_id,
        t.priority_score,
        t.reactivation_segment,
        t.value_tier,
        t.value_score,
        t.urgency_score,
        t.days_inactive,
        t.deposit_segment,
        t.total_deposit_amount,
        t.is_eligible,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(t.skip_reasons_json, '[]'::jsonb))),
        $12::uuid,
        NOW(),
        t.ltv_score,
        t.ltv_tier
      FROM UNNEST(
        $1::uuid[],
        $2::numeric[],
        $3::text[],
        $4::text[],
        $5::smallint[],
        $6::smallint[],
        $7::int[],
        $8::text[],
        $9::numeric[],
        $10::boolean[],
        $11::jsonb[],
        $13::smallint[],
        $14::text[]
      ) AS t(
        contact_id,
        priority_score,
        reactivation_segment,
        value_tier,
        value_score,
        urgency_score,
        days_inactive,
        deposit_segment,
        total_deposit_amount,
        is_eligible,
        skip_reasons_json,
        ltv_score,
        ltv_tier
      )
      ON CONFLICT (contact_id) DO UPDATE SET
        priority_score       = EXCLUDED.priority_score,
        reactivation_segment = EXCLUDED.reactivation_segment,
        value_tier           = EXCLUDED.value_tier,
        value_score          = EXCLUDED.value_score,
        urgency_score        = EXCLUDED.urgency_score,
        days_inactive        = EXCLUDED.days_inactive,
        deposit_segment      = EXCLUDED.deposit_segment,
        total_deposit_amount = EXCLUDED.total_deposit_amount,
        is_eligible          = EXCLUDED.is_eligible,
        skip_reasons         = EXCLUDED.skip_reasons,
        run_id               = EXCLUDED.run_id,
        computed_at          = NOW(),
        ltv_score            = EXCLUDED.ltv_score,
        ltv_tier             = EXCLUDED.ltv_tier
    `

    await this.query(sql, [
      scores.map(s => s.contactId),
      scores.map(s => s.priorityScore),
      scores.map(s => s.reactivationSegment),
      scores.map(s => s.valueTier),
      scores.map(s => s.valueScore),
      scores.map(s => s.urgencyScore),
      scores.map(s => s.daysInactive),
      scores.map(s => s.depositSegment),
      scores.map(s => s.totalDepositAmount),
      scores.map(s => s.isEligible),
      scores.map(s => JSON.stringify(s.skipReasons)),
      runId ?? null,
      scores.map(s => s.ltvScore ?? null),
      scores.map(s => s.ltvTier ?? null),
    ])
  }

  /**
   * Listado paginado para el operador.
   * Filtra por segmento de difusión, tier, plataforma y ventana de inactividad.
   */
  async getPrioritizedContacts(
    filters: PriorityFilters,
  ): Promise<PaginatedResult<PrioritizedContact>> {
    const page     = filters.page     ?? 1
    const pageSize = filters.pageSize ?? 50
    const offset   = (page - 1) * pageSize

    const broadcasted = filters.broadcasted ?? false
    const conditions: string[] = [
      ...(broadcasted ? [] : ['cps.is_eligible = true']),
      'c.deleted_at IS NULL',
      "c.status IN ('active','inactive')",
      'c.opt_in_marketing = true AND c.do_not_contact = false',
      "NOT EXISTS (SELECT 1 FROM blacklist b WHERE b.phone_number_normalized IN (c.phone_number,regexp_replace(c.phone_number,'[^0-9]','','g')) AND b.removed_at IS NULL)",
      `cps.is_broadcasted = ${broadcasted}`,
    ]
    const params: unknown[]    = []
    let   p = 1

    if (filters.reactivationSegment) {
      conditions.push(`cps.reactivation_segment = $${p++}`)
      params.push(filters.reactivationSegment)
    }
    if (filters.valueTier) {
      conditions.push(`cps.value_tier = $${p++}`)
      params.push(filters.valueTier)
    }
    if (filters.platform) {
      conditions.push(`$${p++} = ANY(c.platforms)`)
      params.push(filters.platform)
    }
    if (filters.agent) {
      conditions.push(`c.panel = $${p++}`)
      params.push(filters.agent)
    }
    if (filters.minDaysInactive !== undefined) {
      conditions.push(`cps.days_inactive >= $${p++}`)
      params.push(filters.minDaysInactive)
    }
    if (filters.maxDaysInactive !== undefined) {
      conditions.push(`cps.days_inactive <= $${p++}`)
      params.push(filters.maxDaysInactive)
    }
    if (filters.runId && !broadcasted) {
      conditions.push(`cps.run_id = $${p++}`)
      params.push(filters.runId)
    }

    const scope = priorityAccess(filters.access, params.length)
    params.push(...scope.params); p = params.length + 1
    const where = `WHERE ${conditions.join(' AND ')}${scope.sql}`

    const [countRow] = await this.query<CountRow>(
      `SELECT COUNT(*) AS total
       FROM contact_priority_scores cps
       JOIN contacts c ON c.id = cps.contact_id
       ${where}`,
      params,
    )
    const total = parseInt(countRow.total, 10)

    const dataSql = `
      SELECT
        c.id,
        c.phone_number,
        c.first_name,
        c.last_name,
        c.segment,
        c.platforms,
        c.panel,
        c.last_deposit_at,
        cps.is_broadcasted,
        cps.broadcasted_at,
        cps.broadcasted_by,
        c.total_deposit_amount,
        cps.priority_score,
        cps.reactivation_segment,
        cps.value_tier,
        cps.days_inactive,
        cps.ltv_score,
        cps.ltv_tier,
        FLOOR(
          EXTRACT(EPOCH FROM (NOW() - csh.last_sent)) / 86400
        )::int AS days_since_last_message
      FROM contact_priority_scores cps
      JOIN contacts c ON c.id = cps.contact_id
      -- LATERAL con ventana de 6 meses: usa idx_contact_send_history_contact_sent_at
      -- (contact_id, sent_at DESC). Sin la ventana el planner podría ignorar el índice
      -- en tablas contact_send_history muy grandes. 1 index seek por fila = O(log N).
      LEFT JOIN LATERAL (
        SELECT sent_at AS last_sent
        FROM contact_send_history
        WHERE contact_id = c.id
          AND sent_at > NOW() - INTERVAL '180 days'
        ORDER BY sent_at DESC
        LIMIT 1
      ) csh ON true
      ${where}
      ORDER BY cps.priority_score DESC, cps.reactivation_segment, c.id
      LIMIT $${p++} OFFSET $${p++}
    `
    const rows = await this.query<PrioritizedDbRow>(dataSql, [...params, pageSize, offset])
    // Fetch queue state only for this page, never for the entire scored audience.
    if(rows.length) {
      const states=await this.query<{id:string;state:string|null;busy:boolean}>(`
        SELECT c.id,latest_broadcast.state,COALESCE(latest_broadcast.busy,false) AS busy
        FROM contacts c
      LEFT JOIN LATERAL (
        SELECT CASE WHEN bm.status='queued' AND br.status='failed' THEN 'review'
          WHEN br.status='failed' THEN 'failed' WHEN br.status='skipped' THEN 'skipped'
          WHEN bc.status='cancelled' AND NOT ${PRIORITY_BUSY_SQL} THEN 'cancelled'
          WHEN br.status='sent' THEN 'sent' ELSE 'pending' END AS state,
          ${PRIORITY_BUSY_SQL} AS busy
        FROM priority_broadcasts pb ${PRIORITY_BATCH_JOINS}
        WHERE ba.contact_id=c.id ORDER BY pb.created_at DESC LIMIT 1
      ) latest_broadcast ON true
        WHERE c.id=ANY($1::uuid[])`,[rows.map(row=>row.id)])
      const stateById=new Map(states.map(row=>[row.id,row]))
      rows.forEach(row=>{row.broadcast_state=stateById.get(row.id)?.state??null;row.broadcast_busy=stateById.get(row.id)?.busy??false})
    }


    const [job] = await this.query<{ computed_at: Date | null; is_running: boolean }>(
      `SELECT last_success_at AS computed_at, is_running FROM system_jobs WHERE job_name='prioritization_recompute'`)
    return {
      computedAt: job?.computed_at ? new Date(job.computed_at).toISOString() : null,
      recomputing: job?.is_running ?? false,
      data:       rows.map(mapPrioritized),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /**
   * Retorna un mapa contactId → { ltvScore, ltvTier } para un batch de contactos.
   *
   * Une contacts → casino_contact_account_links (contact↔player ya
   * desambiguado por plataforma, migración 126/127) → casino_players →
   * player_ltv. Si un contacto tiene múltiples cuentas de casino, toma la de
   * mayor ltv_score (DISTINCT ON con ORDER BY ltv_score DESC).
   *
   * CORRECCIÓN (revisión coordinador, mensaje 8 — 2026-09-21): esta función
   * afirmaba unir `player_ltv.casino_player_id = casino_contact_account_links.
   * player_id` directamente, dando por hecho que `player_id` YA era el UUID
   * real de casino_players. Es falso para cualquier jugador con transacciones:
   * `casino_segmentation_players` (de la que sale `player_id`, vía la CTE
   * `players` de la migración 127) genera un id SINTÉTICO
   * `md5('excel:'||platform||':'||lower(username))::uuid` para toda cuenta con
   * transacciones — no el `casino_players.id` real. Ese id sintético nunca
   * coincide con `player_ltv.casino_player_id` (que sí es el UUID real,
   * escrito por `refresh_player_ltv()`), así que el LTV desaparecía para
   * prácticamente todos los contactos. Fix: unir primero a `casino_players`
   * por `(username_lower, platform)` — la misma identidad compuesta que usa
   * `casino_contact_account_links` para resolver el link — y de ahí a
   * `player_ltv` por `casino_players.id`.
   *
   * Antes de esta fase el JOIN era directo contra casino_players por
   * first_name/casino_accounts SIN platform: con la clave de identidad ahora
   * compuesta (platform, username_lower — D2), el mismo username puede
   * corresponder a jugadores de dos plataformas distintas, y ese JOIN podía
   * atarse al equivocado (bigwin/adminbtc). casino_contact_account_links ya
   * resuelve esa ambigüedad (vínculos explícitos primero, luego panel único,
   * luego nombre globalmente único) — se reutiliza en vez de reimplementar la
   * lógica acá.
   *
   * CAVEAT DE PERFORMANCE (no verificado — sin acceso a una base real en esta
   * fase): casino_contact_account_links materializa CTEs sobre TODOS los
   * contactos en cada evaluación; este método puede correr sobre miles de
   * contactos en el job de recompute de prioridades. Si `EXPLAIN ANALYZE`
   * muestra que es lento en producción, la vía de escape es materializar esa
   * vista (o cachear su resultado) en vez de revertir esta corrección de
   * identidad.
   *
   * Contactos sin datos LTV no aparecen en el mapa (caller recibe null al lookup).
   */
  async getLtvMapForContacts(
    contactIds: string[],
  ): Promise<Map<string, { ltvScore: number; ltvTier: ValueTier }>> {
    if (contactIds.length === 0) return new Map()

    if (this.prepared) {
      const rows = await this.query<LtvDbRow>('SELECT contact_id, ltv_score, ltv_tier FROM priority_ltv WHERE contact_id=ANY($1::uuid[])', [contactIds])
      return new Map(rows.map(r => [r.contact_id, { ltvScore: Number(r.ltv_score), ltvTier: r.ltv_tier as ValueTier }]))
    }

    const sql = `
      SELECT DISTINCT ON (l.contact_id)
        l.contact_id AS contact_id,
        pl.ltv_score,
        pl.tier_ltv  AS ltv_tier
      FROM casino_contact_account_links l
      JOIN casino_players cp
        ON cp.username_lower = l.username_lower
       AND cp.platform IS NOT DISTINCT FROM l.platform
      JOIN player_ltv pl ON pl.casino_player_id = cp.id
      WHERE l.contact_id = ANY($1::uuid[])
      ORDER BY l.contact_id, pl.ltv_score DESC NULLS LAST
    `
    try {
      const rows = await this.query<LtvDbRow>(sql, [contactIds])
      const map = new Map<string, { ltvScore: number; ltvTier: ValueTier }>()
      for (const row of rows) {
        map.set(row.contact_id, {
          ltvScore: parseInt(row.ltv_score, 10),
          ltvTier:  row.ltv_tier as ValueTier,
        })
      }
      return map
    } catch {
      // LTV table unavailable (e.g. missing GRANT) — scoring falls back to tier-based value_score
      return new Map()
    }
  }

  // ── Locking distribuido (PostgreSQL-native, multi-instancia) ──────────────

  /**
   * Intenta adquirir el lock del job de recompute.
   *
   * Persiste lockToken en la fila para validar ownership en el release.
   * Solo una instancia puede ganar la carrera (UPDATE atómico con condición).
   * TTL de 30 minutos protege contra instancias que mueren sin liberar el lock.
   */
  async acquireRecomputeLock(instanceId: string, lockToken: string): Promise<boolean> {
    const sql = `
      UPDATE system_jobs
      SET
        is_running  = true,
        started_at  = NOW(),
        started_by  = $1,
        lock_token  = $2,
        expires_at  = NOW() + INTERVAL '30 minutes'
      WHERE job_name = 'prioritization_recompute'
        AND (is_running = false OR expires_at < NOW())
      RETURNING job_name
    `
    const rows = await this.query<{ job_name: string }>(sql, [instanceId, lockToken])
    return rows.length > 0
  }

  /**
   * Renueva el TTL del lock validando que el token sigue siendo nuestro.
   * Retorna false si otra instancia tomó el lock (o el job fue cancelado).
   * Llamar cada HEARTBEAT_INTERVAL_MS durante el recompute para evitar expiración.
   */
  async renewRecomputeLock(lockToken: string): Promise<boolean> {
    const sql = `
      UPDATE system_jobs
      SET expires_at = NOW() + INTERVAL '30 minutes'
      WHERE job_name = 'prioritization_recompute'
        AND lock_token = $1
        AND is_running = true
      RETURNING job_name
    `
    const rows = await query<{ job_name: string }>(sql, [lockToken])
    return rows.length > 0
  }

  /**
   * Retorna el run_id de la última corrida que completó exitosamente.
   * Null si nunca hubo una corrida exitosa (base vacía o primer deploy).
   */
  async getLastCompleteRunId(): Promise<string | null> {
    const sql = `
      SELECT last_complete_run_id
      FROM system_jobs
      WHERE job_name = 'prioritization_recompute'
    `
    const rows = await this.query<{ last_complete_run_id: string | null }>(sql, [])
    return rows[0]?.last_complete_run_id ?? null
  }

  /**
   * Libera el lock validando ownership via lockToken.
   *
   * Si success=true: actualiza last_success_at y registra last_complete_run_id = lockToken.
   * Si success=false: libera el lock sin actualizar marcas de éxito.
   * El AND lock_token = $1 garantiza que una instancia caída no libere el lock de otra.
   *
   * Retorna true si el lock fue liberado, false si el token ya no coincidía
   * (otra instancia expiró y re-adquirió el lock antes del release).
   */
  async releaseRecomputeLock(
    lockToken: string,
    result: Record<string, unknown>,
    success: boolean,
  ): Promise<boolean> {
    if (!success && this.prepared) { await this.client!.query('ROLLBACK'); this.prepared = false }
    const sql = success
      ? `
        UPDATE system_jobs
        SET
          is_running           = false,
          started_at           = NULL,
          started_by           = NULL,
          lock_token           = NULL,
          expires_at           = NULL,
          last_success_at      = NOW(),
          last_complete_run_id = $1::uuid,
          last_result          = $2
        WHERE job_name = 'prioritization_recompute'
          AND lock_token = $1
        RETURNING job_name
      `
      : `
        UPDATE system_jobs
        SET
          is_running  = false,
          started_at  = NULL,
          started_by  = NULL,
          lock_token  = NULL,
          expires_at  = NULL,
          last_result = $2
        WHERE job_name = 'prioritization_recompute'
          AND lock_token = $1
        RETURNING job_name
      `
    const rows = await this.query<{ job_name: string }>(sql, [lockToken, JSON.stringify(result)])
    if (success && this.prepared) {
      await this.client!.query(rows.length > 0 ? 'COMMIT' : 'ROLLBACK')
      this.prepared = false
    }
    return rows.length > 0
  }

  /**
   * Persiste el resultado de una corrida en la tabla de historial (append-only).
   * Se llama tanto en éxito como en fallo/revocación para tener trazabilidad completa.
   */
  async markBroadcasted(contactId: string, userName: string, access?: PriorityAccess): Promise<boolean> {
    const scope = priorityAccess(access, 2)
    const rows = await this.query<{ contact_id: string }>(
      `UPDATE contact_priority_scores cps
       SET is_broadcasted = true, broadcasted_at = NOW(), broadcasted_by = $2, broadcast_campaign_id = NULL
       FROM contacts c
       WHERE cps.contact_id = $1 AND c.id=cps.contact_id AND cps.is_eligible = true AND c.deleted_at IS NULL${scope.sql}
       RETURNING cps.contact_id`,
      [contactId, userName, ...scope.params],
    )
    return rows.length > 0
  }

  async unmarkBroadcasted(contactId: string, access?: PriorityAccess): Promise<boolean> {
    const scope = priorityAccess(access, 1)
    const rows = await this.query<{ contact_id: string }>(
      `UPDATE contact_priority_scores cps
       SET is_broadcasted = false, broadcasted_at = NULL, broadcasted_by = NULL, broadcast_campaign_id = NULL
       FROM contacts c
       WHERE cps.contact_id = $1 AND c.id=cps.contact_id AND c.deleted_at IS NULL${scope.sql}
       RETURNING cps.contact_id`,
      [contactId, ...scope.params],
    )
    return rows.length > 0
  }

  async insertRecomputeRun(run: RecomputeRunRecord): Promise<void> {
    const sql = `
      INSERT INTO recompute_runs (
        run_id, started_at, finished_at, status,
        contacts_processed, contacts_updated, duration_ms,
        error_message, instance_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `
    await this.query(sql, [
      run.runId,
      run.startedAt.toISOString(),
      run.finishedAt.toISOString(),
      run.status,
      run.contactsProcessed,
      run.contactsUpdated,
      run.durationMs,
      run.errorMessage ?? null,
      run.instanceId   ?? null,
    ])
  }
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapMetrics(row: MetricsDbRow): ContactMetricsRow {
  return {
    contactId:          row.contact_id,
    phoneNumber:        row.phone_number,
    firstName:          row.first_name,
    lastName:           row.last_name,
    status:             row.status,
    segment:            row.segment,
    lastDepositAt:      row.last_deposit_at ? new Date(row.last_deposit_at) : null,
    totalDeposits:      parseInt(row.total_deposits ?? '0', 10),
    totalDepositAmount: row.total_deposit_amount ? parseFloat(row.total_deposit_amount) : null,
    lastDepositAmount:  row.last_deposit_amount  ? parseFloat(row.last_deposit_amount)  : null,
    doNotContact:       row.do_not_contact,
    optInMarketing:     row.opt_in_marketing,
    deletedAt:          row.deleted_at ? new Date(row.deleted_at) : null,
    // Enriquecido por el servicio vía getLtvMapForContacts; null hasta ese momento.
    ltvScore:           null,
    ltvTier:            null,
  }
}

function mapPrioritized(row: PrioritizedDbRow): PrioritizedContact {
  return {
    id:                  row.id,
    phoneNumber:         row.phone_number,
    firstName:           row.first_name,
    lastName:            row.last_name,
    segment:             row.segment,
    platforms:           row.platforms ?? [],
    agent:               row.panel ?? null,
    lastDepositAt:       row.last_deposit_at ? new Date(row.last_deposit_at) : null,
    totalDepositAmount:  row.total_deposit_amount ? parseFloat(row.total_deposit_amount) : null,
    priorityScore:       parseFloat(row.priority_score),
    reactivationSegment: row.reactivation_segment as ReactivationSegment | null,
    valueTier:           row.value_tier as ValueTier,
    daysInactive:        row.days_inactive != null ? Number(row.days_inactive) : null,
    daysSinceLastMessage: row.days_since_last_message !== null && row.days_since_last_message !== undefined
      ? parseInt(String(row.days_since_last_message), 10)
      : null,
    isBroadcasted:       row.is_broadcasted,
    broadcastedAt:       row.broadcasted_at ? new Date(row.broadcasted_at) : null,
    broadcastedBy:       row.broadcasted_by ?? null,
    broadcastState:      row.broadcast_state ?? null,
    broadcastBusy:       row.broadcast_busy ?? false,
    ltvScore:            row.ltv_score != null ? Number(row.ltv_score) : null,
    ltvTier:             (row.ltv_tier as ValueTier | null) ?? null,
  }
}
