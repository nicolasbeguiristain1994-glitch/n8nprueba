-- ============================================================
-- BACKFILL: Migración 118 — assigned_line_id en warmup_contacts
-- ============================================================
--
-- PREREQUISITO
-- ────────────
-- Este script puede correr SOLO o después de la migración
-- 118_warmup_contacts_line_assignment.sql. Ambas hacen lo mismo
-- en cuanto al schema (el ALTER TABLE es idempotente con IF NOT EXISTS).
-- Si ya corriste 118_warmup_contacts_line_assignment.sql antes,
-- este script detecta la columna existente y solo ejecuta el backfill.
--
-- COLUMNAS QUE TOCA EN warmup_contacts
-- ─────────────────────────────────────
-- SOLO: assigned_line_id (UUID, nueva).
-- La tabla warmup_contacts NO tiene updated_at → no se menciona en ningún UPDATE.
-- Columnas reales: id, phone_number, is_active, message_count, last_used_at, notes.
--
-- IDEMPOTENCIA
-- ────────────
-- Se puede correr múltiples veces sin efectos secundarios:
--   · ALTER TABLE   → ADD COLUMN IF NOT EXISTS
--   · CREATE INDEX  → verificación previa en pg_indexes
--   · Backfill      → WHERE assigned_line_id IS NULL (solo toca los no asignados)
--
-- RESULTADO ESPERADO EN LA PESTAÑA "Messages" DEL SQL EDITOR
-- ────────────────────────────────────────────────────────────
-- ╔══════════════════════════════════════════════════╗
-- ║  WARMUP — backfill 118_line_assignment           ║
-- ╚══════════════════════════════════════════════════╝
-- ── FASE 1 · Schema …
-- ── FASE 2 · Diagnóstico …
-- ── FASE 3 · Backfill round-robin …
-- ── FASE 4 · Resumen …
-- ============================================================

DO $$
DECLARE
  -- ── Configuración ─────────────────────────────────────────
  MAX_PER_LINE     CONSTANT INT := 12;

  -- ── Estado del schema ──────────────────────────────────────
  v_col_exists     BOOLEAN;
  v_idx1_exists    BOOLEAN;
  v_idx2_exists    BOOLEAN;

  -- ── Conteos ────────────────────────────────────────────────
  v_total_lines     INT;
  v_total_contacts  INT;
  v_unassigned_pre  INT;
  v_unassigned_post INT;
  v_assigned_total  INT := 0;
  v_full_lines      INT;

  -- ── Loop ───────────────────────────────────────────────────
  r RECORD;

BEGIN

  RAISE NOTICE '';
  RAISE NOTICE '╔══════════════════════════════════════════════════╗';
  RAISE NOTICE '║  WARMUP — backfill 118_line_assignment           ║';
  RAISE NOTICE '╚══════════════════════════════════════════════════╝';

  -- ════════════════════════════════════════════════════════════
  -- FASE 1 · Schema  (completamente idempotente)
  -- ════════════════════════════════════════════════════════════

  RAISE NOTICE '';
  RAISE NOTICE '── FASE 1 · Schema ───────────────────────────────────────────────';

  -- ── 1a. Columna assigned_line_id ──────────────────────────

  SELECT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'warmup_contacts'
      AND  column_name  = 'assigned_line_id'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RAISE NOTICE '   [1a] assigned_line_id no existe → ALTER TABLE...';

    EXECUTE $ddl$
      ALTER TABLE warmup_contacts
        ADD COLUMN assigned_line_id UUID
          REFERENCES warmup_numbers(id) ON DELETE SET NULL
    $ddl$;

    EXECUTE $ddl$
      COMMENT ON COLUMN warmup_contacts.assigned_line_id IS
        'Línea propietaria del contacto. NULL = pool libre (auto-asignable). ON DELETE SET NULL devuelve el contacto al pool si la línea es eliminada.'
    $ddl$;

    RAISE NOTICE '   [1a] ✓ Columna assigned_line_id creada.';
  ELSE
    RAISE NOTICE '   [1a] ✓ Columna ya existe — sin cambios.';
  END IF;

  -- ── 1b. Índice principal: lookup por línea ─────────────────
  -- Cubre la query primaria de /api/warmup/process:
  --   WHERE assigned_line_id = $1 AND is_active = true
  --   ORDER BY last_used_at ASC NULLS FIRST, message_count ASC

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE  schemaname = 'public'
      AND  tablename  = 'warmup_contacts'
      AND  indexname  = 'idx_warmup_contacts_line_active'
  ) INTO v_idx1_exists;

  IF NOT v_idx1_exists THEN
    RAISE NOTICE '   [1b] Creando idx_warmup_contacts_line_active...';
    EXECUTE $ddl$
      CREATE INDEX idx_warmup_contacts_line_active
        ON warmup_contacts (assigned_line_id, last_used_at ASC NULLS FIRST, message_count ASC)
        WHERE is_active = true
    $ddl$;
    RAISE NOTICE '   [1b] ✓ Índice creado.';
  ELSE
    RAISE NOTICE '   [1b] ✓ idx_warmup_contacts_line_active ya existe.';
  END IF;

  -- ── 1c. Índice de fallback: contactos sin asignar ──────────
  -- Cubre la auto-asignación en /api/warmup/process:
  --   WHERE is_active = true AND assigned_line_id IS NULL
  --   ORDER BY message_count ASC

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE  schemaname = 'public'
      AND  tablename  = 'warmup_contacts'
      AND  indexname  = 'idx_warmup_contacts_unassigned'
  ) INTO v_idx2_exists;

  IF NOT v_idx2_exists THEN
    RAISE NOTICE '   [1c] Creando idx_warmup_contacts_unassigned...';
    EXECUTE $ddl$
      CREATE INDEX idx_warmup_contacts_unassigned
        ON warmup_contacts (message_count ASC)
        WHERE is_active = true AND assigned_line_id IS NULL
    $ddl$;
    RAISE NOTICE '   [1c] ✓ Índice creado.';
  ELSE
    RAISE NOTICE '   [1c] ✓ idx_warmup_contacts_unassigned ya existe.';
  END IF;

  -- ════════════════════════════════════════════════════════════
  -- FASE 2 · Diagnóstico
  -- ════════════════════════════════════════════════════════════

  RAISE NOTICE '';
  RAISE NOTICE '── FASE 2 · Diagnóstico ──────────────────────────────────────────';

  SELECT COUNT(*) INTO v_total_lines
  FROM   warmup_numbers
  WHERE  warmup_status IN ('active', 'paused');

  SELECT COUNT(*) INTO v_total_contacts
  FROM   warmup_contacts
  WHERE  is_active = true;

  SELECT COUNT(*) INTO v_unassigned_pre
  FROM   warmup_contacts
  WHERE  is_active = true AND assigned_line_id IS NULL;

  RAISE NOTICE '   Líneas elegibles (activas + pausadas) : %', v_total_lines;
  RAISE NOTICE '   Contactos activos total               : %', v_total_contacts;
  RAISE NOTICE '   Sin asignar (antes del backfill)      : %', v_unassigned_pre;
  RAISE NOTICE '   Capacidad total disponible            : %   (% líneas × %/línea)',
    v_total_lines * MAX_PER_LINE, v_total_lines, MAX_PER_LINE;

  IF v_total_lines = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   ⚠ Sin líneas activas ni pausadas — nada que distribuir.';
    RAISE NOTICE '   → Agregar líneas con POST /api/warmup y volver a correr.';
    RETURN;
  END IF;

  -- ════════════════════════════════════════════════════════════
  -- FASE 3 · Backfill — round-robin equilibrado
  -- ════════════════════════════════════════════════════════════

  RAISE NOTICE '';
  RAISE NOTICE '── FASE 3 · Backfill round-robin (máx % por línea) ──────────────', MAX_PER_LINE;

  IF v_unassigned_pre = 0 THEN

    RAISE NOTICE '   ℹ Pool vacío — no hay contactos sin asignar.';
    RAISE NOTICE '     Si alguna línea necesita más contactos:';
    RAISE NOTICE '     1) Agregar contactos con POST /api/warmup/contacts';
    RAISE NOTICE '     2) Volver a correr este script.';

  ELSE

    -- ── Algoritmo: round-robin con ROW_NUMBER contiguo ──────────────────────
    --
    -- Distribuye N contactos entre M líneas repartiendo de a una por ronda,
    -- como repartir cartas en poker. En cada ronda, la línea con menos
    -- contactos actuales recibe primero.
    --
    -- La clave está en cómo se calcula global_pos para mapear cada slot
    -- al contacto correcto:
    --
    --   ✗ INCORRECTO: slot_idx * n_lineas + line_rank
    --     → Con capacidades distintas deja GAPS en la secuencia numérica.
    --     Ejemplo: 3 líneas caps (4,3,2) → posiciones {0,1,2,3,4,5,6,7,9}
    --     El contacto rn=8 no tiene slot asignado → queda sin distribuir.
    --
    --   ✓ CORRECTO: ROW_NUMBER() OVER (ORDER BY slot_idx, line_rank)
    --     → Siempre produce una secuencia 0, 1, 2, …, total_slots-1 sin gaps,
    --     independientemente de que las capacidades sean distintas.
    --
    -- Si los contactos son menos que los slots, el JOIN simplemente no produce
    -- match para los slots con global_pos > max(rn): sin error, sin datos corruptos.
    --
    -- UPDATE: solo actualiza la columna `assigned_line_id`.
    -- warmup_contacts NO tiene columna `updated_at` → no se toca.
    -- ─────────────────────────────────────────────────────────────────────────

    WITH

      -- 1. Numerar contactos disponibles 0-indexed, los menos usados primero
      available AS (
        SELECT
          id,
          ( ROW_NUMBER() OVER (ORDER BY message_count ASC, id ASC) - 1 ) AS rn
        FROM   warmup_contacts
        WHERE  is_active        = true
          AND  assigned_line_id IS NULL
      ),

      -- 2. Líneas con capacidad disponible (current < MAX_PER_LINE)
      --    line_rank 0 = la que menos contactos tiene actualmente
      line_caps AS (
        SELECT
          wn.id                                               AS line_id,
          COUNT(wc.id)::int                                   AS current_count,
          ( MAX_PER_LINE - COUNT(wc.id)::int )                AS capacity,
          ( ROW_NUMBER() OVER (
              ORDER BY COUNT(wc.id) ASC, wn.created_at ASC
            ) - 1 )::int                                      AS line_rank
        FROM   warmup_numbers    wn
        LEFT   JOIN warmup_contacts wc
               ON  wc.assigned_line_id = wn.id
               AND wc.is_active = true
        WHERE  wn.warmup_status IN ('active', 'paused')
        GROUP  BY wn.id, wn.created_at
        HAVING ( MAX_PER_LINE - COUNT(wc.id)::int ) > 0
      ),

      -- 3. Expandir cada línea en tantas filas como slots vacíos tenga
      --    slot_idx: 0 = primer slot a llenar, 1 = segundo, etc.
      slots_expanded AS (
        SELECT
          lc.line_id,
          lc.line_rank,
          s.slot_idx
        FROM   line_caps lc
        CROSS  JOIN generate_series(0, lc.capacity - 1) AS s(slot_idx)
      ),

      -- 4. Número global contiguo por slot, ordenado ronda a ronda:
      --    · slot_idx ASC  → ronda 0 primero (todos reciben 1 antes de que alguien reciba 2)
      --    · line_rank ASC → dentro de la ronda, la línea con menos contactos va antes
      --    ROW_NUMBER produce 1, 2, 3, … ; restamos 1 para que empiece en 0 (= rn de available)
      slots AS (
        SELECT
          line_id,
          ( ROW_NUMBER() OVER (ORDER BY slot_idx ASC, line_rank ASC) - 1 ) AS global_pos
        FROM   slots_expanded
      ),

      -- 5. Cruce: slot con global_pos N recibe el contacto con rn N
      assignment AS (
        SELECT
          s.line_id,
          a.id AS contact_id
        FROM   slots     s
        JOIN   available a ON a.rn = s.global_pos
      )

    -- ── UPDATE ────────────────────────────────────────────────────────────────
    -- Solo modifica assigned_line_id.
    -- warmup_contacts no tiene updated_at — no se incluye en el SET.
    UPDATE warmup_contacts wc
    SET    assigned_line_id = asgn.line_id
    FROM   assignment       asgn
    WHERE  wc.id            = asgn.contact_id;

    GET DIAGNOSTICS v_assigned_total = ROW_COUNT;

    RAISE NOTICE '   ✓ Contactos asignados en esta ejecución: %', v_assigned_total;

  END IF;

  -- ════════════════════════════════════════════════════════════
  -- FASE 4 · Resumen final
  -- ════════════════════════════════════════════════════════════

  RAISE NOTICE '';
  RAISE NOTICE '── FASE 4 · Resumen ──────────────────────────────────────────────';

  SELECT COUNT(*) INTO v_unassigned_post
  FROM   warmup_contacts
  WHERE  is_active = true AND assigned_line_id IS NULL;

  RAISE NOTICE '   Asignados en este run        : %', v_assigned_total;
  RAISE NOTICE '   Sin asignar después del run  : %', v_unassigned_post;
  RAISE NOTICE '';
  RAISE NOTICE '   Instancia                        Contactos   Estado';
  RAISE NOTICE '   ───────────────────────────────  ──────────  ──────────';

  FOR r IN (
    SELECT
      wn.instance_name,
      wn.warmup_status,
      COUNT(wc.id) AS asignados
    FROM   warmup_numbers wn
    LEFT   JOIN warmup_contacts wc
           ON  wc.assigned_line_id = wn.id
           AND wc.is_active = true
    WHERE  wn.warmup_status IN ('active', 'paused')
    GROUP  BY wn.id, wn.instance_name, wn.warmup_status
    ORDER  BY COUNT(wc.id) DESC, wn.instance_name ASC
  ) LOOP
    RAISE NOTICE '   %  %  %',
      rpad(r.instance_name, 31),
      lpad(r.asignados::text, 10),
      r.warmup_status;
  END LOOP;

  RAISE NOTICE '';

  IF v_unassigned_post = 0 THEN

    RAISE NOTICE '   ✅ Todos los contactos fueron distribuidos correctamente.';

  ELSE

    SELECT COUNT(*) INTO v_full_lines
    FROM (
      SELECT wn.id
      FROM   warmup_numbers wn
      LEFT   JOIN warmup_contacts wc
             ON  wc.assigned_line_id = wn.id
             AND wc.is_active = true
      WHERE  wn.warmup_status IN ('active', 'paused')
      GROUP  BY wn.id
      HAVING COUNT(wc.id) >= MAX_PER_LINE
    ) sub;

    IF v_full_lines = v_total_lines THEN
      RAISE NOTICE '   ⚠ % contactos sin asignar.', v_unassigned_post;
      RAISE NOTICE '     Todas las % líneas ya alcanzaron el máximo de %.',
        v_total_lines, MAX_PER_LINE;
      RAISE NOTICE '     → Aumentar MAX_PER_LINE (línea 19) o agregar más líneas de warmup.';
    ELSE
      RAISE NOTICE '   ⚠ % contactos sin asignar (% / % líneas en máximo).',
        v_unassigned_post, v_full_lines, v_total_lines;
      RAISE NOTICE '     → Correr este script nuevamente para distribuir el remanente.';
    END IF;

  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '╔══════════════════════════════════════════════════╗';
  RAISE NOTICE '║  ✅ Script completado sin errores.               ║';
  RAISE NOTICE '╚══════════════════════════════════════════════════╝';
  RAISE NOTICE '';

END;
$$;


-- ============================================================
-- VERIFICACIÓN INDEPENDIENTE
-- ============================================================
-- Correr por separado después del DO block para auditar resultados:

-- SELECT
--   wn.instance_name,
--   wn.warmup_status,
--   COUNT(wc.id)                                         AS contactos_asignados,
--   COUNT(wc.id) FILTER (WHERE wc.last_used_at IS NULL)  AS nunca_usados,
--   MIN(wc.message_count)                                AS min_msgs,
--   MAX(wc.message_count)                                AS max_msgs
-- FROM warmup_numbers wn
-- LEFT JOIN warmup_contacts wc
--   ON  wc.assigned_line_id = wn.id
--   AND wc.is_active = true
-- WHERE wn.warmup_status IN ('active', 'paused')
-- GROUP BY wn.id, wn.instance_name, wn.warmup_status
-- ORDER BY contactos_asignados DESC, wn.instance_name;
