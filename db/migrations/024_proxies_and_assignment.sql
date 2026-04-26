-- Migration 024: Proxy registry + line-proxy assignment module
--
-- Adds infrastructure for associating WhatsApp lines with network proxies for
-- operational routing. This is an operational assignment / health / failover
-- module only — NOT anti-detection, ban-evasion, or stealth functionality.
--
-- Source-of-truth decision:
--   whatsapp_lines.proxy_id = the currently assigned proxy for a line.
--   line_proxy_assignment_log = append-only audit/observability only.
--   These two must never compete — only proxy_id is authoritative.
--
-- Sticky assignment principle:
--   If a line already has a healthy proxy, it keeps it.
--   Rotation only happens on clear health failure or explicit operator request.
--
-- Additive: no existing columns renamed, dropped, or type-changed.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS throughout.


-- ── 1. proxies: operational proxy registry ─────────────────────────────────────
--
-- Stores network proxies available for WhatsApp line routing.
-- Health status is set by external health-check processes or manual admin update.
--
-- password_ref: a non-secret reference only (e.g. env variable name, vault path).
--   Raw credentials are never stored here. The application resolves the actual
--   credential at request time from the environment or a secrets manager.
--
-- sticky_line_id: optional soft preference — this proxy prefers to be assigned
--   to that line. Does not prevent assignment to other lines if needed.

CREATE TABLE IF NOT EXISTS proxies (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  label             VARCHAR(100) NOT NULL,
  host              VARCHAR(255) NOT NULL,
  port              INT          NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol          VARCHAR(10)  NOT NULL DEFAULT 'http'
                    CHECK (protocol IN ('http', 'https', 'socks5')),
  username          VARCHAR(100),
  -- non-secret reference only; never the raw password
  password_ref      TEXT,
  country           VARCHAR(2),   -- ISO 3166-1 alpha-2 (e.g. 'AR', 'US')
  region            VARCHAR(50),
  city              VARCHAR(50),
  provider          VARCHAR(100),
  proxy_type        VARCHAR(20)  NOT NULL DEFAULT 'datacenter'
                    CHECK (proxy_type IN ('datacenter', 'residential', 'mobile')),
  rotating_endpoint BOOLEAN      NOT NULL DEFAULT false,
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  -- health_status: updated by health-check process or admin
  health_status     VARCHAR(20)  NOT NULL DEFAULT 'unknown'
                    CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  latency_ms        INT          CHECK (latency_ms >= 0),
  bans_detected     INT          NOT NULL DEFAULT 0 CHECK (bans_detected >= 0),
  last_checked_at   TIMESTAMPTZ,
  -- soft sticky preference — proxy prefers this line but is not locked to it
  sticky_line_id    UUID         REFERENCES whatsapp_lines(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proxies_active_health
  ON proxies(health_status)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_proxies_active_country
  ON proxies(country)
  WHERE country IS NOT NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_proxies_sticky_line
  ON proxies(sticky_line_id)
  WHERE sticky_line_id IS NOT NULL;


-- ── 2. whatsapp_lines: proxy assignment columns ────────────────────────────────
--
-- proxy_id: the CURRENT authoritative proxy assignment for this line.
--   NULL = no proxy assigned (direct connection).
--   Non-null = the proxy currently in use for this line's Evolution API calls.
--
-- last_proxy_rotated_at: timestamp of the most recent proxy change.
-- last_assignment_score: the score computed at the last intelligentAssign run.
-- last_assignment_reason: JSONB breakdown of the last assignment decision.

ALTER TABLE whatsapp_lines
  ADD COLUMN IF NOT EXISTS proxy_id               UUID        REFERENCES proxies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_proxy_rotated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_assignment_score  NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS last_assignment_reason JSONB;

CREATE INDEX IF NOT EXISTS idx_whatsapp_lines_proxy_id
  ON whatsapp_lines(proxy_id)
  WHERE proxy_id IS NOT NULL;


-- ── 3. line_proxy_assignment_log: append-only audit/observability ──────────────
--
-- Records every proxy assignment or rotation event for a line.
-- This table is PURELY for audit and observability.
-- It must NEVER be used as the source of truth for current assignment.
-- The current assignment lives exclusively in whatsapp_lines.proxy_id.
--
-- assignment_type values:
--   auto      — chosen automatically by intelligentAssign (advisory, no mutation)
--   manual    — explicit operator/admin action via rotate-proxy endpoint
--   rotation  — replacement triggered by health failure detection
--   failover  — emergency replacement (previous proxy became unavailable)
--   release   — proxy detached from line without a replacement

CREATE TABLE IF NOT EXISTS line_proxy_assignment_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id           UUID        NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  proxy_id          UUID        REFERENCES proxies(id) ON DELETE SET NULL,
  previous_proxy_id UUID        REFERENCES proxies(id) ON DELETE SET NULL,
  campaign_id       UUID        REFERENCES campaigns(id) ON DELETE SET NULL,
  assignment_type   VARCHAR(20) NOT NULL
                    CHECK (assignment_type IN ('auto', 'manual', 'rotation', 'failover', 'release')),
  score             NUMERIC(5,2),
  reason            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lpal_line_created
  ON line_proxy_assignment_log(line_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lpal_proxy_id
  ON line_proxy_assignment_log(proxy_id)
  WHERE proxy_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lpal_campaign_id
  ON line_proxy_assignment_log(campaign_id)
  WHERE campaign_id IS NOT NULL;
