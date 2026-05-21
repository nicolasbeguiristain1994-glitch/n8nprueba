-- Permite asociar una campaña con una lista de difusión de prospects
-- como alternativa a la lista de contactos (list_id).
-- Ambas son mutuamente excluyentes: se usa una u otra.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS prospect_list_id UUID
    REFERENCES prospect_lists(id) ON DELETE SET NULL;
