/**
 * distributor.ts
 *
 * Line + Proxy Assignment engine.
 *
 * Purpose: given the current fleet of WhatsApp lines and available proxies,
 * choose the best line (and optionally the best proxy) for a campaign send.
 *
 * Design principles:
 *   - ADVISORY by default (persist=false). Never mutates DB unless persist=true.
 *   - Sticky assignment: if a line already has a healthy proxy, keep it.
 *   - Rotate only on clear health failure or explicit operator request.
 *   - Single source of truth: whatsapp_lines.proxy_id.
 *     line_proxy_assignment_log is append-only audit — never queried for state.
 *   - NOT anti-detection, ban-evasion, or stealth — purely operational routing.
 *
 * Scoring formula (0-100):
 *   reputation  (0-40):  7-day avg delivery_rate / 100 * 40
 *   capacity    (0-25):  min(remaining_hour/limit_hour, remaining_day/limit_day) * 25
 *   priority    (0-15):  15 - (line.priority - 1) * 3, clamped [0,15]
 *   proxy_health (0-20): healthy→20, unknown/no-proxy→15, degraded→10, unhealthy→0
 */

import { query } from '@/lib/db'

// ── Types ──────────────────────────────────────────────────────────────────────

export type ProxyProtocol  = 'http' | 'https' | 'socks5'
export type ProxyType      = 'datacenter' | 'residential' | 'mobile'
export type ProxyHealth    = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
export type AssignmentType = 'auto' | 'manual' | 'rotation' | 'failover' | 'release'

export type ProxyRow = {
  id:                string
  label:             string
  host:              string
  port:              number
  protocol:          ProxyProtocol
  username:          string | null
  password_ref:      string | null
  country:           string | null
  region:            string | null
  city:              string | null
  provider:          string | null
  proxy_type:        ProxyType
  rotating_endpoint: boolean
  is_active:         boolean
  health_status:     ProxyHealth
  latency_ms:        number | null
  bans_detected:     number
  last_checked_at:   string | null
  sticky_line_id:    string | null
  notes:             string | null
  created_at:        string
  updated_at:        string
}

/** Line row joined with 7-day aggregated metrics and current proxy fields. */
export type CandidateLine = {
  id:                    string
  line_key:              string
  display_name:          string
  phone_number:          string
  evolution_instance:    string
  evolution_url:         string
  status:                string
  is_connected:          boolean
  sending_enabled:       boolean
  msgs_sent_hour:        number
  msgs_sent_today:       number
  msg_per_hour:          number
  msg_per_day:           number
  priority:              number
  last_seen_at:          string | null
  assigned_region:       string | null
  proxy_id:              string | null
  last_proxy_rotated_at: string | null
  last_assignment_score: number | null
  /** 7-day average delivery rate (0-100). Defaults to 100 if no data. */
  avg_delivery_rate:     number
  /** 7-day average error rate (0-100). Defaults to 0 if no data. */
  avg_error_rate:        number
  proxy_health:          ProxyHealth | null
  proxy_latency:         number | null
  proxy_is_active:       boolean | null
}

export type AssignmentScore = {
  total:        number   // 0-100
  reputation:   number   // 0-40
  capacity:     number   // 0-25
  priority:     number   // 0-15
  proxy_health: number   // 0-20
}

/**
 * proxyAction in the result:
 *   keep    — line has a healthy proxy; no change needed
 *   replace — line has an unhealthy/inactive proxy; was replaced
 *   none    — line had no proxy (proxy field is whatever was found or null)
 */
export type ProxyActionKind = 'keep' | 'replace' | 'none'

export type AssignmentResult = {
  line:        CandidateLine
  score:       AssignmentScore
  proxy:       ProxyRow | null
  proxyAction: ProxyActionKind
}

export type AssignRequest = {
  /** Campaign context for the audit log. */
  campaignId?:    string
  /** Prefer proxies in this ISO 3166-1 alpha-2 country code. */
  preferCountry?: string
  /** Return top N lines. Default 1. */
  topN?:          number
  /**
   * When true, writes proxy assignments to DB and appends audit log rows.
   * Default false (advisory mode — no mutations).
   */
  persist?:       boolean
  /** User ID for audit log entries. */
  requestedBy?:   string
}

export type AssignResponse = {
  results:         AssignmentResult[]
  filteredOut:     number
  totalCandidates: number
}

export type DistributorStats = {
  lines: {
    total:      number
    eligible:   number
    with_proxy: number
  }
  proxies: {
    total:      number
    healthy:    number
    degraded:   number
    unhealthy:  number
    unknown:    number
    unassigned: number
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export function scoreCandidate(line: CandidateLine): AssignmentScore {
  // reputation: avg delivery rate → 0-40 pts
  const reputation = Math.round((Math.min(100, Math.max(0, line.avg_delivery_rate)) / 100) * 40)

  // capacity: fraction of remaining capacity → 0-25 pts
  const remainingHour = Math.max(0, line.msg_per_hour  - line.msgs_sent_hour)
  const remainingDay  = Math.max(0, line.msg_per_day   - line.msgs_sent_today)
  const capHour  = line.msg_per_hour > 0 ? remainingHour / line.msg_per_hour : 0
  const capDay   = line.msg_per_day  > 0 ? remainingDay  / line.msg_per_day  : 0
  const capacity = Math.round(Math.min(capHour, capDay) * 25)

  // priority: priority=1 → 15pts, each +1 step subtracts 3, clamped [0,15]
  const priorityScore = Math.max(0, Math.min(15, 15 - (line.priority - 1) * 3))

  // proxy_health
  let proxyHealthScore: number
  switch (line.proxy_health) {
    case 'healthy':   proxyHealthScore = 20; break
    case 'unknown':   proxyHealthScore = 15; break
    case 'degraded':  proxyHealthScore = 10; break
    case 'unhealthy': proxyHealthScore = 0;  break
    default:          proxyHealthScore = 15; break  // no proxy = direct connection
  }

  const total = reputation + capacity + priorityScore + proxyHealthScore

  return { total, reputation, capacity, priority: priorityScore, proxy_health: proxyHealthScore }
}

// ── Hard filter ───────────────────────────────────────────────────────────────

/**
 * Remove lines that cannot receive any messages right now.
 * Does NOT exclude lines with unhealthy proxies — those are handled by scoring
 * and proxy replacement logic.
 */
export function hardFilter(lines: CandidateLine[]): CandidateLine[] {
  return lines.filter(l =>
    l.status === 'active' &&
    l.is_connected &&
    l.sending_enabled &&
    l.msgs_sent_hour  < l.msg_per_hour &&
    l.msgs_sent_today < l.msg_per_day
  )
}

// ── Proxy decision ────────────────────────────────────────────────────────────

/** Determine what to do with the line's current proxy. */
function currentProxyAction(line: CandidateLine): ProxyActionKind {
  if (!line.proxy_id)             return 'none'
  if (line.proxy_is_active === false) return 'replace'
  if (line.proxy_health === 'unhealthy') return 'replace'
  return 'keep'
}

// ── selectBestProxy ───────────────────────────────────────────────────────────

/**
 * Find the best available proxy for a line.
 * Ordering priority:
 *   1. sticky match (proxy.sticky_line_id = lineId)
 *   2. country preference
 *   3. type: residential > mobile > datacenter
 *   4. health: healthy > unknown > degraded
 *   5. prefer proxies not already assigned to another line
 *   6. lowest latency
 *
 * Excludes unhealthy and inactive proxies.
 * Excludes the current proxy when doing a replacement.
 */
async function selectBestProxy(params: {
  lineId:         string
  currentProxyId: string | null
  excludeProxy?:  string | null
  preferCountry?: string | null
}): Promise<ProxyRow | null> {
  const { lineId, excludeProxy, preferCountry } = params

  const rows = await query<ProxyRow>(
    `SELECT p.*
     FROM proxies p
     WHERE p.is_active       = true
       AND p.health_status  != 'unhealthy'
       AND ($1::uuid IS NULL OR p.id != $1)
     ORDER BY
       -- 1. sticky match first
       (p.sticky_line_id = $2) DESC,
       -- 2. country preference
       CASE WHEN $3::varchar IS NOT NULL AND p.country = $3 THEN 0 ELSE 1 END,
       -- 3. proxy type: residential > mobile > datacenter
       CASE p.proxy_type
         WHEN 'residential' THEN 0
         WHEN 'mobile'      THEN 1
         ELSE                    2
       END,
       -- 4. health: healthy > unknown > degraded
       CASE p.health_status
         WHEN 'healthy'  THEN 0
         WHEN 'unknown'  THEN 1
         ELSE                 2
       END,
       -- 5. prefer proxies not already assigned to another active line
       (EXISTS(
         SELECT 1 FROM whatsapp_lines wl
         WHERE wl.proxy_id = p.id AND wl.id != $2
       )) ASC,
       -- 6. lowest latency
       COALESCE(p.latency_ms, 9999) ASC
     LIMIT 1`,
    [excludeProxy ?? null, lineId, preferCountry ?? null]
  )

  return rows[0] ?? null
}

// ── Persist helpers ───────────────────────────────────────────────────────────

async function writeProxyAssignment(params: {
  line:           CandidateLine
  newProxyId:     string
  newProxy?:      ProxyRow | null
  actionKind:     ProxyActionKind
  score:          AssignmentScore
  campaignId:     string | null
  requestedBy:    string | null
}): Promise<void> {
  const { line, newProxyId, newProxy, actionKind, score, campaignId, requestedBy } = params

  const assignmentType: AssignmentType = actionKind === 'replace' ? 'rotation' : 'auto'

  // Only update proxy_id when it actually changes (sticky principle)
  if (newProxyId !== line.proxy_id) {
    await query(
      `UPDATE whatsapp_lines
       SET proxy_id = $1, last_proxy_rotated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [newProxyId, line.id]
    )

    // Fire-and-forget: push new proxy config to the Evolution instance.
    // Inlined here (not imported from proxy-manager) to avoid circular dependency.
    const apiKey = process.env.EVOLUTION_API_KEY
    if (apiKey && line.evolution_url && line.evolution_instance && newProxy) {
      const proxyBody: Record<string, string> = {
        proxyHost:     newProxy.host,
        proxyPort:     String(newProxy.port),
        proxyProtocol: newProxy.protocol,
      }
      if (newProxy.username)     proxyBody.proxyUsername = newProxy.username
      if (newProxy.password_ref) proxyBody.proxyPassword = newProxy.password_ref

      fetch(`${line.evolution_url}/instance/update/${line.evolution_instance}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body:    JSON.stringify(proxyBody),
        signal:  AbortSignal.timeout(10_000),
      })
        .then(r => {
          if (r.ok) {
            console.log(`[distributor] proxy synced to Evolution: ${line.evolution_instance} → ${newProxy.host}:${newProxy.port}`)
          } else {
            r.text()
              .then(t => console.warn(`[distributor] Evolution proxy sync failed ${r.status} (${line.evolution_instance}): ${t}`))
              .catch(() => {})
          }
        })
        .catch(e => console.warn(
          `[distributor] Evolution proxy sync error (${line.evolution_instance}):`,
          e instanceof Error ? e.message : e,
        ))
    }
  }

  // Append to immutable audit log
  await query(
    `INSERT INTO line_proxy_assignment_log
       (line_id, proxy_id, previous_proxy_id, campaign_id,
        assignment_type, score, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      line.id,
      newProxyId,
      line.proxy_id,
      campaignId,
      assignmentType,
      score.total,
      JSON.stringify(score),
      requestedBy,
    ]
  )
}

// ── intelligentAssign ─────────────────────────────────────────────────────────

/**
 * Main assignment function.
 *
 * Gathers all candidate lines, filters ineligible ones, scores them,
 * resolves proxy assignments, and optionally persists decisions to DB.
 *
 * In advisory mode (persist=false, the default) this is a pure read — safe
 * to call in preview UIs without side effects.
 */
export async function intelligentAssign(req: AssignRequest = {}): Promise<AssignResponse> {
  const { campaignId, preferCountry, topN = 1, persist = false, requestedBy } = req

  // 1. Fetch candidate lines with aggregated 7-day metrics and current proxy state
  const candidateRows = await query<CandidateLine>(`
    SELECT
      wl.id,
      wl.line_key,
      wl.display_name,
      wl.phone_number,
      wl.evolution_instance,
      wl.evolution_url,
      wl.status,
      wl.is_connected,
      wl.sending_enabled,
      wl.msgs_sent_hour,
      wl.msgs_sent_today,
      wl.msg_per_hour,
      wl.msg_per_day,
      wl.priority,
      wl.last_seen_at,
      wl.assigned_region,
      wl.proxy_id,
      wl.last_proxy_rotated_at,
      wl.last_assignment_score,
      COALESCE(AVG(lm.delivery_rate), 100)::numeric(5,2) AS avg_delivery_rate,
      COALESCE(AVG(lm.error_rate),    0  )::numeric(5,2) AS avg_error_rate,
      p.health_status AS proxy_health,
      p.latency_ms    AS proxy_latency,
      p.is_active     AS proxy_is_active
    FROM whatsapp_lines wl
    LEFT JOIN line_metrics lm
      ON lm.line_id = wl.id
      AND lm.metric_date >= CURRENT_DATE - INTERVAL '7 days'
    LEFT JOIN proxies p ON p.id = wl.proxy_id
    GROUP BY
      wl.id, wl.line_key, wl.display_name, wl.phone_number,
      wl.evolution_instance, wl.evolution_url,
      wl.status, wl.is_connected, wl.sending_enabled,
      wl.msgs_sent_hour, wl.msgs_sent_today,
      wl.msg_per_hour, wl.msg_per_day,
      wl.priority, wl.last_seen_at, wl.assigned_region,
      wl.proxy_id, wl.last_proxy_rotated_at, wl.last_assignment_score,
      p.health_status, p.latency_ms, p.is_active
  `)

  const totalCandidates = candidateRows.length

  // 2. Hard filter
  const eligible = hardFilter(candidateRows)
  const filteredOut = totalCandidates - eligible.length

  // 3. Score and sort
  const scored = eligible
    .map(line => ({ line, score: scoreCandidate(line), action: currentProxyAction(line) }))
    .sort((a, b) => b.score.total - a.score.total)

  const top = scored.slice(0, topN)

  // 4. Resolve proxies and optionally persist
  const results: AssignmentResult[] = []

  for (const { line, score, action } of top) {
    let resolvedProxy: ProxyRow | null = null
    let finalAction: ProxyActionKind = action

    if (action === 'keep') {
      // Sticky: re-fetch the current proxy row for the response
      const proxyRows = await query<ProxyRow>('SELECT * FROM proxies WHERE id = $1', [line.proxy_id!])
      resolvedProxy = proxyRows[0] ?? null
    } else {
      // 'replace' (bad proxy) or 'none' (no proxy) — look for a candidate
      const candidate = await selectBestProxy({
        lineId:         line.id,
        currentProxyId: line.proxy_id,
        excludeProxy:   action === 'replace' ? line.proxy_id : null,
        preferCountry:  preferCountry ?? line.assigned_region ?? null,
      })
      resolvedProxy = candidate

      if (persist && candidate) {
        await writeProxyAssignment({
          line,
          newProxyId:  candidate.id,
          newProxy:    candidate,
          actionKind:  action,
          score,
          campaignId:  campaignId ?? null,
          requestedBy: requestedBy ?? null,
        })
      }
    }

    // Update last_assignment_score on the line (advisory writes are still useful for
    // observability even when persist=false for proxy changes)
    if (persist) {
      await query(
        `UPDATE whatsapp_lines
         SET last_assignment_score  = $1,
             last_assignment_reason = $2,
             updated_at             = NOW()
         WHERE id = $3`,
        [score.total, JSON.stringify(score), line.id]
      )
    }

    results.push({ line, score, proxy: resolvedProxy, proxyAction: finalAction })
  }

  return { results, filteredOut, totalCandidates }
}

// ── rotateProxy ───────────────────────────────────────────────────────────────

/**
 * Force a proxy rotation for a specific line.
 * Always mutates the DB — this is an explicit operator action.
 *
 * assignmentType defaults to 'manual'.
 * If no suitable proxy is found, the line's proxy_id is set to NULL (release).
 */
export async function rotateProxy(params: {
  lineId:         string
  campaignId?:    string
  requestedBy?:   string
  assignmentType?: AssignmentType
}): Promise<{ line: CandidateLine; proxy: ProxyRow | null }> {
  const { lineId, campaignId, requestedBy, assignmentType = 'manual' } = params

  // Fetch line with proxy state (no aggregate needed — just current state)
  const lineRows = await query<CandidateLine>(`
    SELECT
      wl.*,
      100::numeric(5,2) AS avg_delivery_rate,
      0::numeric(5,2)   AS avg_error_rate,
      p.health_status AS proxy_health,
      p.latency_ms    AS proxy_latency,
      p.is_active     AS proxy_is_active
    FROM whatsapp_lines wl
    LEFT JOIN proxies p ON p.id = wl.proxy_id
    WHERE wl.id = $1
  `, [lineId])

  if (lineRows.length === 0) throw new Error(`Line not found: ${lineId}`)
  const line = lineRows[0]

  const newProxy = await selectBestProxy({
    lineId:         lineId,
    currentProxyId: line.proxy_id,
    excludeProxy:   line.proxy_id,             // force away from current proxy
    preferCountry:  line.assigned_region ?? null,
  })

  const score = scoreCandidate(line)

  if (newProxy) {
    // Assign new proxy
    await query(
      `UPDATE whatsapp_lines
       SET proxy_id = $1, last_proxy_rotated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [newProxy.id, lineId]
    )
    await query(
      `INSERT INTO line_proxy_assignment_log
         (line_id, proxy_id, previous_proxy_id, campaign_id,
          assignment_type, score, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [lineId, newProxy.id, line.proxy_id, campaignId ?? null,
       assignmentType, score.total, JSON.stringify(score), requestedBy ?? null]
    )
  } else {
    // No replacement found — release current proxy
    await query(
      `UPDATE whatsapp_lines
       SET proxy_id = NULL, last_proxy_rotated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [lineId]
    )
    await query(
      `INSERT INTO line_proxy_assignment_log
         (line_id, proxy_id, previous_proxy_id, campaign_id,
          assignment_type, score, reason, created_by)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
      [lineId, line.proxy_id, campaignId ?? null,
       'release', score.total, JSON.stringify(score), requestedBy ?? null]
    )
  }

  await query(
    `UPDATE whatsapp_lines
     SET last_assignment_score  = $1,
         last_assignment_reason = $2,
         updated_at             = NOW()
     WHERE id = $3`,
    [score.total, JSON.stringify(score), lineId]
  )

  return { line, proxy: newProxy }
}

// ── getDistributorStats ───────────────────────────────────────────────────────

export async function getDistributorStats(): Promise<DistributorStats> {
  const lineRows = await query<{ total: number; eligible: number; with_proxy: number }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE status         = 'active'
          AND is_connected   = true
          AND sending_enabled = true
          AND msgs_sent_hour  < msg_per_hour
          AND msgs_sent_today < msg_per_day
      )::int AS eligible,
      COUNT(*) FILTER (WHERE proxy_id IS NOT NULL)::int AS with_proxy
    FROM whatsapp_lines
  `)

  const proxyRows = await query<{
    total: number
    healthy: number
    degraded: number
    unhealthy: number
    unknown: number
    unassigned: number
  }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE health_status = 'healthy' )::int AS healthy,
      COUNT(*) FILTER (WHERE health_status = 'degraded')::int AS degraded,
      COUNT(*) FILTER (WHERE health_status = 'unhealthy')::int AS unhealthy,
      COUNT(*) FILTER (WHERE health_status = 'unknown' )::int AS unknown,
      COUNT(*) FILTER (
        WHERE id NOT IN (
          SELECT proxy_id FROM whatsapp_lines WHERE proxy_id IS NOT NULL
        )
      )::int AS unassigned
    FROM proxies
    WHERE is_active = true
  `)

  return {
    lines:   lineRows[0]  ?? { total: 0, eligible: 0, with_proxy: 0 },
    proxies: proxyRows[0] ?? { total: 0, healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, unassigned: 0 },
  }
}
