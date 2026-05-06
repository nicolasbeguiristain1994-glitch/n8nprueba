-- 055_campaigns_pause_reason_extended.sql
-- Extiende el CHECK constraint de pause_reason para incluir 'all_lines_outside_schedule',
-- que distingue el caso "líneas activas pero todas fuera de su ventana de personalidad"
-- del caso "ninguna línea elegible en absoluto" (no_eligible_lines).
--
-- Esta distinción mejora debugging operativo: el operador sabe si tiene que
-- esperar a que las líneas entren en horario (outside_schedule) vs. agregar
-- más líneas o reconectar las existentes (no_eligible_lines).

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_pause_reason_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_pause_reason_check
  CHECK (pause_reason IN (
    'manual',
    'no_eligible_lines',
    'all_lines_outside_schedule',
    'systemic_error',
    'config_missing',
    'frequency_exhausted',
    'unknown'
  ));
