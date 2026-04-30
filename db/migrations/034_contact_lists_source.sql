-- Migration 034: Agregar columna source a contact_lists
-- Permite distinguir listas predefinidas de casino ('casino') de las
-- creadas manualmente por usuarios ('user'). El GET /api/lists filtra
-- source != 'casino' para mantener la UI limpia.

ALTER TABLE contact_lists
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'user';

-- Marcar retroactivamente las listas casino ya existentes por nombre
-- (nombres canónicos del casino-lists.json — estables y únicos)
UPDATE contact_lists
SET source = 'casino'
WHERE name IN (
  'inactivos royal',
  '✨ Nuevos VIP / Alto',
  '🕰️ Veteranos Inactivos',
  '🚨 Críticos — Alto',
  '🚨 Críticos — VIP',
  '📊 Todos los Activos VIP+Alto',
  '📊 Medio Inactivos',
  '🏢 Royal — Inactivos',
  '🏢 Ofizeus — Inactivos',
  '🏢 Farabet — Inactivos',
  '🏢 Bigwin — Inactivos',
  '🏢 Betcoin — Inactivos',
  '🆕 Nuevos VIP',
  '🆕 Nuevos (todos)',
  '🏆 VIP Regulares',
  '⭐ VIP Frecuentes',
  '📉 Alto en Riesgo',
  '🎯 Alto Inactivos',
  '⚠️ VIP en Riesgo',
  '🎰 VIP Inactivos'
);
