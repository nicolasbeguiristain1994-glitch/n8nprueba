-- 026_contact_segment_casino.sql
-- Agrega los valores de segmentación de casino al enum contact_segment.
-- Los valores anteriores (casual, regular, vip, whale) se mantienen por compatibilidad.

ALTER TYPE contact_segment ADD VALUE IF NOT EXISTS 'bajo';
ALTER TYPE contact_segment ADD VALUE IF NOT EXISTS 'medio';
ALTER TYPE contact_segment ADD VALUE IF NOT EXISTS 'alto';
