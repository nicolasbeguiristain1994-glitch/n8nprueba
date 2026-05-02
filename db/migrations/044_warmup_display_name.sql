-- Migration 044: Correcciones al módulo de warmup
--
-- 1. Agrega display_name a warmup_numbers (usado en UI y API pero faltaba en schema)
-- 2. Agrega evolution_url a warmup_numbers (permite especificar servidor Evolution
--    por instancia; si NULL, el motor usa la variable EVOLUTION_URL del entorno)
--
-- Ambas columnas usan IF NOT EXISTS — seguro ejecutar con tráfico activo.

ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);

ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS evolution_url VARCHAR(255);

COMMENT ON COLUMN warmup_numbers.display_name IS
  'Nombre legible para mostrar en la UI. Si NULL se usa instance_name.';

COMMENT ON COLUMN warmup_numbers.evolution_url IS
  'URL base del servidor Evolution para esta instancia (ej: http://evolution:8080).
   Si NULL el motor de warmup usa la variable de entorno EVOLUTION_URL.';
