-- 054_campaigns_pause_reason.sql
-- Persiste el motivo por el que una campaña fue pausada.
--   manual             → operador pulsó "Pausar"
--   no_eligible_lines  → todas las líneas están fuera de horario o sin cuota
--   systemic_error     → errores consecutivos de la API de envío
--   config_missing     → falta EVOLUTION_API_KEY u otra config obligatoria
--   frequency_exhausted → todos los contactos bloqueados por frecuencia
--   unknown            → pausa inesperada sin causa clasificada

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS pause_reason TEXT
  CHECK (pause_reason IN (
    'manual',
    'no_eligible_lines',
    'systemic_error',
    'config_missing',
    'frequency_exhausted',
    'unknown'
  ));
