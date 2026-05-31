-- ============================================================
-- Migration 106: Renombrar tiers de segmentación
--   vip  → super_vip
--   alto → vip
--
-- Objetivo: unificar la nomenclatura interna con los labels
-- que ya se muestran en la UI (Super Vip / Vip / Medio / Bajo),
-- eliminando la divergencia entre nombres de DB y nombres de pantalla.
--
-- Orden de pasos:
--   1. Renombrar valores del enum contact_segment
--   2. Actualizar datos en segmentation_tiers
--   3. Reconstruir CHECK constraint en segmentation_tiers
--   4. Reconstruir CHECK constraint en contact_priority_scores
--   5. Reconstruir CHECK constraint en casino_players (seg_monto)
--   6. Reconstruir CHECK constraint en contact_frequency_rules (seg_monto)
-- ============================================================

BEGIN;

-- ── 1. Enum contact_segment ───────────────────────────────────────────────────
-- Orden importa: renombrar 'vip' primero libera el nombre para que 'alto' lo tome.

ALTER TYPE contact_segment RENAME VALUE 'vip'  TO 'super_vip';
ALTER TYPE contact_segment RENAME VALUE 'alto' TO 'vip';


-- ── 2. Datos en segmentation_tiers ───────────────────────────────────────────
-- Misma precaución: actualizar 'vip' → 'super_vip' antes de que 'alto' tome el
-- valor 'vip', para no violar la futura CHECK constraint.

UPDATE segmentation_tiers SET tier = 'super_vip' WHERE tier = 'vip';
UPDATE segmentation_tiers SET tier = 'vip'       WHERE tier = 'alto';


-- ── 3. CHECK constraint en segmentation_tiers ────────────────────────────────

ALTER TABLE segmentation_tiers
  DROP CONSTRAINT IF EXISTS segmentation_tiers_tier_check;

ALTER TABLE segmentation_tiers
  ADD CONSTRAINT segmentation_tiers_tier_check
  CHECK (tier IN ('super_vip', 'vip', 'medio', 'bajo'));


-- ── 4. CHECK constraint en contact_priority_scores ───────────────────────────

ALTER TABLE contact_priority_scores
  DROP CONSTRAINT IF EXISTS contact_priority_scores_value_tier_check;

UPDATE contact_priority_scores SET value_tier = 'super_vip' WHERE value_tier = 'vip';
UPDATE contact_priority_scores SET value_tier = 'vip'       WHERE value_tier = 'alto';

ALTER TABLE contact_priority_scores
  ADD CONSTRAINT contact_priority_scores_value_tier_check
  CHECK (value_tier IN ('super_vip', 'vip', 'medio', 'bajo'));


-- ── 5. CHECK constraint en casino_players (seg_monto) ────────────────────────

ALTER TABLE casino_players
  DROP CONSTRAINT IF EXISTS casino_players_seg_monto_check;

UPDATE casino_players SET seg_monto = 'super_vip' WHERE seg_monto = 'vip';
UPDATE casino_players SET seg_monto = 'vip'       WHERE seg_monto = 'alto';

ALTER TABLE casino_players
  ADD CONSTRAINT casino_players_seg_monto_check
  CHECK (seg_monto IN ('super_vip', 'vip', 'medio', 'bajo'));


-- ── 6. CHECK constraint en contact_frequency_rules (seg_monto) ───────────────

ALTER TABLE contact_frequency_rules
  DROP CONSTRAINT IF EXISTS contact_frequency_rules_seg_monto_check;

UPDATE contact_frequency_rules SET seg_monto = 'super_vip' WHERE seg_monto = 'vip';
UPDATE contact_frequency_rules SET seg_monto = 'vip'       WHERE seg_monto = 'alto';

ALTER TABLE contact_frequency_rules
  ADD CONSTRAINT contact_frequency_rules_seg_monto_check
  CHECK (seg_monto IN ('super_vip', 'vip', 'medio', 'bajo'));


COMMIT;
