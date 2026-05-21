-- Pipeline de estados para prospects (Fase 1).
--
-- stage representa el estado de avance del prospecto en el ciclo de ventas/captación.
-- Es independiente de status (active/unsubscribed/converted), que modela el estado
-- operativo del registro, no el progreso del funnel.
--
-- Estados de Fase 1:
--   nuevo       — ingresó a la base, aún no fue contactado
--   contactado  — se le envió al menos una campaña o el operador lo contactó
--   interesado  — respondió o mostró señales positivas
--   descartado  — no tiene potencial o pidió no ser contactado
--
-- Valor por defecto 'nuevo' para todos los prospects existentes y nuevos.
-- Prospects descartados se excluyen del seeding de campañas en el distribuidor
-- (ver campaign-distributor.ts → createDispatchUnitsFromProspectList).
--
-- NOT NULL con DEFAULT: evita manejar NULLs en queries y simplifica la lógica
-- del distribuidor. Si en el futuro se agrega una migración parcial, la condición
-- del distribuidor ya está preparada.

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'nuevo';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prospects_stage_check'
      AND conrelid = 'prospects'::regclass
  ) THEN
    ALTER TABLE prospects
      ADD CONSTRAINT prospects_stage_check
      CHECK (stage IN ('nuevo', 'contactado', 'interesado', 'descartado'));
  END IF;
END
$$;

-- Índice parcial para el caso de uso más frecuente del distribuidor:
-- filtrar descartados. Un índice completo sobre stage sería pequeño de todos modos
-- (cardinalidad 4), pero el parcial es más compacto y el planner lo prefiere
-- para el filtro WHERE stage != 'descartado'.
CREATE INDEX IF NOT EXISTS idx_prospects_stage_descartado
  ON prospects(id)
  WHERE stage = 'descartado';
