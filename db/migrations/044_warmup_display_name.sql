-- Migration 044: Correcciones al módulo de warmup
--
-- 1. Agrega display_name a warmup_numbers (usado en UI y API pero faltaba en schema)
-- 2. Agrega evolution_url a warmup_numbers (permite especificar servidor Evolution
--    por instancia; si NULL, el motor usa la variable EVOLUTION_URL del entorno)
--
-- Ambas columnas usan IF NOT EXISTS — seguro ejecutar con tráfico activo.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'warmup_numbers') THEN
    ALTER TABLE warmup_numbers ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
    ALTER TABLE warmup_numbers ADD COLUMN IF NOT EXISTS evolution_url VARCHAR(255);
  END IF;
END $$;
