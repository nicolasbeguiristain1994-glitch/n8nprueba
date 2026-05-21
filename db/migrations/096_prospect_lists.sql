-- Listas de difusión: agrupaciones de prospects para envíos masivos.
-- Separado de contact_lists para mantener aislamiento entre contactos
-- confirmados (CRM) y prospects de bases externas.

CREATE TABLE IF NOT EXISTS prospect_lists (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  description    TEXT,
  -- member_count se mantiene sincronizado mediante trigger (ver abajo).
  -- No se usa COUNT(*) en tiempo real para evitar full-scans en listas grandes.
  member_count   INTEGER     NOT NULL DEFAULT 0,
  -- last_used_at se actualiza desde la capa de aplicación cuando una campaña
  -- que referencia esta lista transiciona a estado 'running' (dispatch route).
  last_used_at   TIMESTAMPTZ,
  -- campaign_count se almacena como referencia pero se calcula dinámicamente
  -- en el endpoint GET /api/prospect-lists vía subquery correlacionada.
  campaign_count INTEGER     NOT NULL DEFAULT 0,
  created_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prospect_list_members (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_list_id UUID        NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  prospect_id      UUID        NOT NULL REFERENCES prospects(id)      ON DELETE CASCADE,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(prospect_list_id, prospect_id)
);

-- Índices para acelerar lookups por lista (listar miembros) y por prospect
-- (verificar en qué listas está un prospect).
CREATE INDEX IF NOT EXISTS idx_plm_list_id     ON prospect_list_members(prospect_list_id);
CREATE INDEX IF NOT EXISTS idx_plm_prospect_id ON prospect_list_members(prospect_id);

-- ── updated_at automático ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_prospect_lists_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER prospect_lists_updated_at
  BEFORE UPDATE ON prospect_lists
  FOR EACH ROW EXECUTE FUNCTION set_prospect_lists_updated_at();

-- ── member_count incremental ───────────────────────────────────────────────────
--
-- Por qué trigger ROW-LEVEL en lugar de STATEMENT-LEVEL:
--   Un trigger de statement recibe NEW/OLD como tablas de transición, no como
--   filas individuales, lo que requiere GROUP BY para sumar por prospect_list_id.
--   Eso complica el código sin beneficio real: las inserciones bulk que hacemos
--   (ON CONFLICT DO NOTHING sobre los IDs ya presentes) rara vez superan los
--   5000 elementos por llamada. Para volúmenes de esa magnitud la diferencia
--   de rendimiento entre row-level y statement-level es negligible.
--   Si en el futuro se requieren inserciones de millones de filas en batch,
--   la alternativa es deshabilitar el trigger durante el bulk y recalcular:
--     UPDATE prospect_lists pl SET member_count = (
--       SELECT COUNT(*) FROM prospect_list_members WHERE prospect_list_id = pl.id
--     ) WHERE id = <list_id>;
--
-- El trigger se activa AFTER INSERT OR DELETE para que el conteo refleje el
-- estado post-operación. RETURN NULL (trigger AFTER) es correcto; el valor
-- de retorno no afecta la fila origen.

CREATE OR REPLACE FUNCTION update_prospect_list_member_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE prospect_lists
    SET member_count = member_count + 1
    WHERE id = NEW.prospect_list_id;
  ELSIF TG_OP = 'DELETE' THEN
    -- GREATEST(0, ...) es un guard defensivo: evita contadores negativos en caso
    -- de inconsistencia de datos (por ejemplo, filas borradas sin pasar por el trigger).
    UPDATE prospect_lists
    SET member_count = GREATEST(0, member_count - 1)
    WHERE id = OLD.prospect_list_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER prospect_list_members_count
  AFTER INSERT OR DELETE ON prospect_list_members
  FOR EACH ROW EXECUTE FUNCTION update_prospect_list_member_count();
