-- ============================================================
-- Migration 107: Agregar tiers VIP Medio y VIP Alto
--
-- Nuevos niveles de segmentación (6 en total):
--   bajo       → < $100.000/mes activo
--   medio      → $100.000 – $499.999/mes activo
--   vip        → $500.000 – $999.999/mes activo   (ahora "VIP Bajo" en UI)
--   vip_medio  → $1.000.000 – $1.500.000/mes activo  ← NUEVO
--   vip_alto   → $1.500.001 – $3.199.999/mes activo  ← NUEVO
--   super_vip  → >= $3.200.000/mes activo
-- ============================================================

BEGIN;

-- ── 1. Agregar nuevos valores al enum contact_segment ────────────────────────
-- ALTER TYPE ... ADD VALUE es seguro (no requiere DROP/recrear el enum).
-- Los valores se agregan al final del enum.

ALTER TYPE contact_segment ADD VALUE IF NOT EXISTS 'vip_medio';
ALTER TYPE contact_segment ADD VALUE IF NOT EXISTS 'vip_alto';


-- ── 2. CHECK constraint en segmentation_tiers ────────────────────────────────
ALTER TABLE segmentation_tiers
  DROP CONSTRAINT IF EXISTS segmentation_tiers_tier_check;

ALTER TABLE segmentation_tiers
  ADD CONSTRAINT segmentation_tiers_tier_check
  CHECK (tier IN ('super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo'));


-- ── 3. Insertar filas para los nuevos tiers (si no existen) ─────────────────
INSERT INTO segmentation_tiers
  (tier, workspace_id, min_days_inactive, max_days_inactive, value_score,
   deposit_threshold_min, recontact_cooldown_days, is_active, updated_at)
VALUES
  ('vip_medio', 'default', 7, 165, 52, 1000000, 4, true, NOW()),
  ('vip_alto',  'default', 7, 175, 56, 1500000, 3, true, NOW())
ON CONFLICT (tier, workspace_id) DO NOTHING;


-- ── 4. CHECK constraint en contact_priority_scores ───────────────────────────
ALTER TABLE contact_priority_scores
  DROP CONSTRAINT IF EXISTS contact_priority_scores_value_tier_check;

ALTER TABLE contact_priority_scores
  ADD CONSTRAINT contact_priority_scores_value_tier_check
  CHECK (value_tier IN ('super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo'));


-- ── 5. CHECK constraint en casino_players (seg_monto) ────────────────────────
ALTER TABLE casino_players
  DROP CONSTRAINT IF EXISTS casino_players_seg_monto_check;

ALTER TABLE casino_players
  ADD CONSTRAINT casino_players_seg_monto_check
  CHECK (seg_monto IN ('super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo'));


-- ── 6. CHECK constraint en contact_frequency_rules (seg_monto) ───────────────
ALTER TABLE contact_frequency_rules
  DROP CONSTRAINT IF EXISTS contact_frequency_rules_seg_monto_check;

ALTER TABLE contact_frequency_rules
  ADD CONSTRAINT contact_frequency_rules_seg_monto_check
  CHECK (seg_monto IN ('super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo'));


COMMIT;
