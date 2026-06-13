import { query } from '@/lib/db'
import type { ValueTier } from '@/lib/user-prioritization/config'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface PlayerLtv {
  casinoPlayerId: string
  username:       string
  agente:         string | null
  segMonto:       string | null
  ngrTotal:       number | null
  arpu:           number | null
  diasActivo:     number | null
  ltvPercentil:   number | null
  ltvScore:       number
  tierLtv:        ValueTier
  calculadoEn:    Date
}

export interface LtvDistributionRow {
  agente:   string | null
  tierLtv:  ValueTier
  total:    number
}

export interface LtvRecomputeResult {
  rowsProcessed: number
  durationMs:    number
  calculatedAt:  Date
}

// ── Tipos internos ────────────────────────────────────────────────────────────

interface PlayerLtvDbRow {
  casino_player_id: string
  username:         string
  agente:           string | null
  seg_monto:        string | null
  ngr_total:        string | null
  arpu:             string | null
  dias_activo:      string | null
  ltv_percentil:    string | null
  ltv_score:        string
  tier_ltv:         string
  calculado_en:     Date
}

interface DistributionDbRow {
  agente:   string | null
  tier_ltv: string
  total:    string
}

interface RefreshResultDbRow {
  rows_processed: number
  duration_ms:    number
  calculated_at:  string
}

interface CountRow { total: string }

// ── Repository ────────────────────────────────────────────────────────────────

export class LtvRepository {
  /**
   * Ejecuta refresh_player_ltv() y refresca la vista materializada.
   * Retorna las métricas del run.
   */
  async refreshAll(): Promise<LtvRecomputeResult> {
    const [result] = await query<RefreshResultDbRow>(
      `SELECT * FROM refresh_player_ltv()`,
      [],
    )

    await query(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_player_ltv`,
      [],
    )

    return {
      rowsProcessed: result.rows_processed,
      durationMs:    Math.round(Number(result.duration_ms)),
      calculatedAt:  new Date(result.calculated_at),
    }
  }

  /**
   * Listado paginado de jugadores con su LTV.
   * Filtra por agente y/o tier_ltv si se pasan.
   */
  async getPlayers(opts: {
    agente?:      string
    tierLtv?:     ValueTier
    minPercentil?: number
    page?:        number
    pageSize?:    number
  }): Promise<{ data: PlayerLtv[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page     = opts.page     ?? 1
    const pageSize = opts.pageSize ?? 50
    const offset   = (page - 1) * pageSize

    const conditions: string[] = []
    const params: unknown[]    = []
    let p = 1

    if (opts.agente) {
      conditions.push(`mv.agente = $${p++}`)
      params.push(opts.agente)
    }
    if (opts.tierLtv) {
      conditions.push(`mv.tier_ltv = $${p++}`)
      params.push(opts.tierLtv)
    }
    if (opts.minPercentil !== undefined) {
      conditions.push(`mv.ltv_percentil >= $${p++}`)
      params.push(opts.minPercentil)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const [countRow] = await query<CountRow>(
      `SELECT COUNT(*) AS total FROM mv_player_ltv mv ${where}`,
      params,
    )
    const total = parseInt(countRow.total, 10)

    const rows = await query<PlayerLtvDbRow>(
      `SELECT
         mv.casino_player_id,
         mv.username,
         mv.agente,
         mv.seg_monto,
         mv.ngr_total,
         mv.arpu,
         mv.dias_activo,
         mv.ltv_percentil,
         mv.ltv_score,
         mv.tier_ltv,
         mv.calculado_en
       FROM mv_player_ltv mv
       ${where}
       ORDER BY mv.ltv_percentil DESC NULLS LAST
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, pageSize, offset],
    )

    return {
      data:       rows.map(mapPlayerLtv),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /**
   * Distribución de jugadores por agente y tier_ltv (para el panel de settings).
   */
  async getDistribution(): Promise<LtvDistributionRow[]> {
    const rows = await query<DistributionDbRow>(
      `SELECT
         agente,
         tier_ltv,
         COUNT(*)::int AS total
       FROM mv_player_ltv
       GROUP BY agente, tier_ltv
       ORDER BY agente NULLS LAST, tier_ltv`,
      [],
    )
    return rows.map(r => ({
      agente:  r.agente,
      tierLtv: r.tier_ltv as ValueTier,
      total:   parseInt(r.total, 10),
    }))
  }

  /**
   * Timestamp del último cálculo exitoso de LTV (desde system_jobs).
   */
  async getLastSuccessAt(): Promise<Date | null> {
    const rows = await query<{ last_success_at: Date | null }>(
      `SELECT last_success_at FROM system_jobs WHERE job_name = 'ltv_recompute'`,
      [],
    )
    const ts = rows[0]?.last_success_at
    return ts ? new Date(ts) : null
  }

  // ── Locking distribuido (mismo patrón que UserPrioritizationRepository) ────

  async acquireLock(instanceId: string, lockToken: string): Promise<boolean> {
    const rows = await query<{ job_name: string }>(
      `UPDATE system_jobs
       SET
         is_running = true,
         started_at = NOW(),
         started_by = $1,
         lock_token = $2,
         expires_at = NOW() + INTERVAL '30 minutes'
       WHERE job_name = 'ltv_recompute'
         AND (is_running = false OR expires_at < NOW())
       RETURNING job_name`,
      [instanceId, lockToken],
    )
    return rows.length > 0
  }

  async renewLock(lockToken: string): Promise<boolean> {
    const rows = await query<{ job_name: string }>(
      `UPDATE system_jobs
       SET expires_at = NOW() + INTERVAL '30 minutes'
       WHERE job_name = 'ltv_recompute'
         AND lock_token = $1
         AND is_running = true
       RETURNING job_name`,
      [lockToken],
    )
    return rows.length > 0
  }

  async releaseLock(
    lockToken: string,
    result: Record<string, unknown>,
    success: boolean,
  ): Promise<boolean> {
    const sql = success
      ? `UPDATE system_jobs
         SET
           is_running      = false,
           started_at      = NULL,
           started_by      = NULL,
           lock_token      = NULL,
           expires_at      = NULL,
           last_success_at = NOW(),
           last_result     = $2
         WHERE job_name = 'ltv_recompute' AND lock_token = $1
         RETURNING job_name`
      : `UPDATE system_jobs
         SET
           is_running  = false,
           started_at  = NULL,
           started_by  = NULL,
           lock_token  = NULL,
           expires_at  = NULL,
           last_result = $2
         WHERE job_name = 'ltv_recompute' AND lock_token = $1
         RETURNING job_name`
    const rows = await query<{ job_name: string }>(sql, [lockToken, JSON.stringify(result)])
    return rows.length > 0
  }
}

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapPlayerLtv(row: PlayerLtvDbRow): PlayerLtv {
  return {
    casinoPlayerId: row.casino_player_id,
    username:       row.username,
    agente:         row.agente,
    segMonto:       row.seg_monto,
    ngrTotal:       row.ngr_total    ? parseFloat(row.ngr_total)    : null,
    arpu:           row.arpu         ? parseFloat(row.arpu)         : null,
    diasActivo:     row.dias_activo  ? parseInt(row.dias_activo, 10) : null,
    ltvPercentil:   row.ltv_percentil ? parseFloat(row.ltv_percentil) : null,
    ltvScore:       parseInt(row.ltv_score, 10),
    tierLtv:        row.tier_ltv as ValueTier,
    calculadoEn:    new Date(row.calculado_en),
  }
}
