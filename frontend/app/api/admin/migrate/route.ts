import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

/**
 * POST /api/admin/migrate
 *
 * Aplica migraciones idempotentes pendientes directamente desde el app server.
 * Solo accesible a admins. Seguro de re-ejecutar (todas las sentencias usan
 * IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).
 *
 * Llamar una sola vez cuando hay columnas faltantes en producción.
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const results: { step: string; ok: boolean; error?: string }[] = []

  async function run(step: string, sql: string) {
    try {
      await query(sql)
      results.push({ step, ok: true })
    } catch (e) {
      results.push({ step, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── 054: campaigns.pause_reason ───────────────────────────────────────────
  await run('054a: add pause_reason column', `
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS pause_reason TEXT
  `)

  // Eliminar constraint viejo si existe (sin el valor all_lines_outside_schedule)
  await run('054b: drop old pause_reason check', `
    ALTER TABLE campaigns
      DROP CONSTRAINT IF EXISTS campaigns_pause_reason_check
  `)

  await run('054c: add extended pause_reason check', `
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
      ))
  `)

  // ── 055: whatsapp_lines.evolution_url ─────────────────────────────────────
  await run('055: add evolution_url to whatsapp_lines', `
    ALTER TABLE whatsapp_lines
      ADD COLUMN IF NOT EXISTS evolution_url TEXT
  `)

  // ── 109: casino_accounts column ───────────────────────────────────────────
  await run('109a: add casino_accounts column', `
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS casino_accounts jsonb NOT NULL DEFAULT '[]'
  `)

  // ── 110: Re-segmentar desde casino_transactions ────────────────────────────
  // Recalcula seg_monto y seg_actividad usando MAX(fecha) real de transacciones.
  // Esto corrige contactos que figuran como "frecuente" sin depósitos recientes.
  await run('110a: recalculate casino_players seg_actividad from transactions', `
    WITH has_tx AS (
      SELECT EXISTS(SELECT 1 FROM casino_transactions WHERE tipo = 'carga') AS any_tx
    ),
    active_months AS (
      SELECT
        LOWER(ct.username)                                AS username_lower,
        COUNT(DISTINCT DATE_TRUNC('month', ct.fecha))::int AS meses_con_cargas,
        MAX(ct.fecha)::date                               AS last_tx_date
      FROM casino_transactions ct
      WHERE ct.tipo = 'carga'
      GROUP BY LOWER(ct.username)
    ),
    carga_mensual AS (
      SELECT
        cp.id,
        cp.username_lower,
        cp.total_cargas,
        COALESCE(am.meses_con_cargas, 1) AS meses_activos,
        ROUND(cp.total_cargas::numeric / GREATEST(COALESCE(am.meses_con_cargas, 1), 1)) AS avg_mensual,
        CASE
          WHEN ht.any_tx AND am.last_tx_date IS NULL THEN NULL
          ELSE COALESCE(am.last_tx_date, cp.fecha_ultima)
        END AS fecha_real_ultima
      FROM casino_players cp
      CROSS JOIN has_tx ht
      LEFT JOIN active_months am ON am.username_lower = cp.username_lower
    )
    UPDATE casino_players cp
    SET
      dias_desde_ultimo = CASE
        WHEN cm.fecha_real_ultima IS NOT NULL THEN (CURRENT_DATE - cm.fecha_real_ultima)
        ELSE NULL
      END,
      seg_monto = CASE
        WHEN cm.avg_mensual >= 3200000 THEN 'super_vip'
        WHEN cm.avg_mensual >= 1500000 THEN 'vip_alto'
        WHEN cm.avg_mensual >= 1000000 THEN 'vip_medio'
        WHEN cm.avg_mensual >=  500000 THEN 'vip'
        WHEN cm.avg_mensual >=  100000 THEN 'medio'
        ELSE 'bajo'
      END,
      seg_actividad = CASE
        WHEN cm.fecha_real_ultima IS NULL OR (CURRENT_DATE - cm.fecha_real_ultima) > 180 THEN 'perdido'
        WHEN (CURRENT_DATE - cm.fecha_real_ultima) > 60                                  THEN 'inactivo'
        WHEN (CURRENT_DATE - cm.fecha_real_ultima) > 30                                  THEN 'en_riesgo'
        WHEN cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) <= 30    THEN 'nuevo'
        WHEN cp.fecha_primera IS NOT NULL
          AND (cp.cant_cargas::numeric / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 3
                                                                                         THEN 'frecuente'
        WHEN cp.fecha_primera IS NOT NULL
          AND (cp.cant_cargas::numeric / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 1
                                                                                         THEN 'regular'
        ELSE 'ocasional'
      END,
      updated_at = NOW()
    FROM carga_mensual cm
    WHERE cm.id = cp.id
  `)

  // 110b-110e: join solo por first_name para evitar timeout (EXISTS+jsonb es O(n*m))
  await run('110b: sync contacts.segment from casino_players', `
    UPDATE contacts c
    SET segment = cp.seg_monto::contact_segment, updated_at = NOW()
    FROM casino_players cp
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
      AND cp.seg_monto IS NOT NULL
      AND c.segment::text IS DISTINCT FROM cp.seg_monto
  `)

  await run('110c: delete stale casino activity/antiquity/risk tags', `
    DELETE FROM contact_tags ct
    WHERE (ct.tag LIKE 'casino:actividad:%'
        OR ct.tag LIKE 'casino:antiguedad:%'
        OR ct.tag LIKE 'casino:valor_riesgo:%')
      AND ct.contact_id IN (
        SELECT c.id FROM contacts c
        JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
        WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL
      )
  `)

  await run('110d: re-insert updated casino tags', `
    INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
    SELECT gen_random_uuid(), c.id,
      unnest(array_remove(ARRAY[
        'casino:actividad:' || cp.seg_actividad,
        CASE
          WHEN cp.fecha_primera IS NULL                             THEN NULL
          WHEN (CURRENT_DATE - cp.fecha_primera) <  30             THEN 'casino:antiguedad:nuevo'
          WHEN (CURRENT_DATE - cp.fecha_primera) <  90             THEN 'casino:antiguedad:reciente'
          WHEN (CURRENT_DATE - cp.fecha_primera) < 150             THEN 'casino:antiguedad:establecido'
          WHEN (CURRENT_DATE - cp.fecha_primera) < 270             THEN 'casino:antiguedad:veterano'
          ELSE                                                           'casino:antiguedad:leal'
        END,
        CASE
          WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND cp.seg_monto IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
          WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND cp.seg_monto = 'medio'                                     THEN 'casino:valor_riesgo:medio'
          WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND cp.seg_monto = 'bajo'                                      THEN 'casino:valor_riesgo:bajo'
          ELSE NULL
        END
      ], NULL)),
      'migration_110', NOW()
    FROM contacts c
    JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
    WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL
    ON CONFLICT (contact_id, tag) DO NOTHING
  `)

  // 110e usa casino_transactions como fuente de verdad para last_deposit_at.
  // casino_players.fecha_ultima puede estar desactualizado; MAX(casino_transactions.fecha)
  // es la fecha real del último depósito. Si no hay transacciones para un usuario,
  // last_deposit_at queda en NULL → el módulo de prioridades lo omite correctamente.
  await run('110e: sync last_deposit_at from casino_transactions', `
    UPDATE contacts c
    SET
      total_deposits    = COALESCE(am.cant_cargas, 0),
      total_withdrawals = cp.cant_retiros,
      last_deposit_at   = am.last_tx_date,
      updated_at        = NOW()
    FROM casino_players cp
    LEFT JOIN (
      SELECT
        LOWER(username)            AS username_lower,
        COUNT(*)                   AS cant_cargas,
        MAX(fecha)::timestamptz    AS last_tx_date
      FROM casino_transactions
      WHERE tipo = 'carga'
      GROUP BY LOWER(username)
    ) am ON am.username_lower = cp.username_lower
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
      AND (
        c.total_deposits IS DISTINCT FROM COALESCE(am.cant_cargas, 0)
        OR c.last_deposit_at IS DISTINCT FROM am.last_tx_date
      )
  `)

  // ── 111: Soft-delete contactos con nombres de agentes ───────────────────────
  await run('111: soft-delete contacts with agent names', `
    UPDATE contacts
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE LOWER(TRIM(first_name)) IN ('betcoin','farabet','bigwin','royal','ofizeus','zeus','zeusroyal')
      AND deleted_at IS NULL
  `)

  // ── 112: Re-sync last_deposit_at para TODOS los contactos desde casino_transactions ──
  // Fuerza la actualización (sin condición IS DISTINCT FROM) para sobreescribir
  // cualquier valor stale de casino_players.fecha_ultima que haya quedado del paso 110e.
  // Contactos sin transacciones en casino_transactions quedan con last_deposit_at = NULL
  // y serán omitidos por el módulo de prioridades (skip: no_deposit_history).
  await run('112: force-resync last_deposit_at from casino_transactions', `
    UPDATE contacts c
    SET
      total_deposits  = COALESCE(am.cant_cargas, 0),
      last_deposit_at = am.last_tx_date,
      updated_at      = NOW()
    FROM casino_players cp
    LEFT JOIN (
      SELECT
        LOWER(username)         AS username_lower,
        COUNT(*)                AS cant_cargas,
        MAX(fecha)::timestamptz AS last_tx_date
      FROM casino_transactions
      WHERE tipo = 'carga'
      GROUP BY LOWER(username)
    ) am ON am.username_lower = cp.username_lower
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
  `)

  // ── 113: Fix platforms detection for multi-username fields and digit suffixes ──
  // Updates trigger + backfills all contacts so that names like
  // "(C.MUCHO)Mario46z3/mario46be" correctly get platforms = ['zeus','bet30'].
  // Changes:
  //   Zeus  regex: z(e|s|eus)?$  →  z(e|s|eus)?\d*$  (allows trailing digits)
  //   Bet30 regex: b(t)?$        →  b(t|e)?\d*$       (allows 'be' suffix and digits)
  //   Both: also tested per-token (split by / space etc.) not just on full field.
  await run('113a: update compute_contact_platforms trigger', `
    CREATE OR REPLACE FUNCTION compute_contact_platforms()
    RETURNS trigger AS $$
    DECLARE
      v_is_zeus  boolean := false;
      v_is_bet30 boolean := false;
      v_full     text;
    BEGIN
      v_full := COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '');

      IF v_full ~* 'z(e|s|eus)?\\d*$' THEN
        v_is_zeus := true;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM unnest(regexp_split_to_array(v_full, '[\\s/\\\\|,;]+')) AS tok
          WHERE LENGTH(REGEXP_REPLACE(LOWER(tok), '^\\([^)]*\\)', '')) > 2
            AND REGEXP_REPLACE(LOWER(tok), '^\\([^)]*\\)', '') ~* 'z(e|s|eus)?\\d*$'
        ) INTO v_is_zeus;
        IF NOT v_is_zeus THEN
          SELECT EXISTS (
            SELECT 1
            FROM casino_players cp
            JOIN LATERAL unnest(regexp_split_to_array(v_full, '[\\s/\\\\|,;]+')) AS tok ON true
            WHERE LENGTH(tok) > 2
              AND cp.username_lower = REGEXP_REPLACE(LOWER(tok), '^\\([^)]*\\)', '')
              AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
          ) INTO v_is_zeus;
        END IF;
      END IF;

      IF v_full ~* 'b(t|e)?\\d*$' THEN
        v_is_bet30 := true;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM unnest(regexp_split_to_array(v_full, '[\\s/\\\\|,;]+')) AS tok
          WHERE LENGTH(REGEXP_REPLACE(LOWER(tok), '^\\([^)]*\\)', '')) > 2
            AND REGEXP_REPLACE(LOWER(tok), '^\\([^)]*\\)', '') ~* 'b(t|e)?\\d*$'
        ) INTO v_is_bet30;
      END IF;

      NEW.platforms := ARRAY_REMOVE(ARRAY[
        CASE WHEN v_is_zeus  THEN 'zeus'  END,
        CASE WHEN v_is_bet30 THEN 'bet30' END
      ], NULL);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  await run('113b: backfill platforms with new logic', `
    WITH tokens AS (
      SELECT id,
             COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') AS full_name
      FROM contacts
    ),
    per_token AS (
      SELECT t.id, REGEXP_REPLACE(LOWER(tok), '^\\([^)]*\\)', '') AS clean_tok
      FROM tokens t
      JOIN LATERAL unnest(regexp_split_to_array(t.full_name, '[\\s/\\\\|,;]+')) AS tok ON true
      WHERE LENGTH(tok) > 2
    )
    UPDATE contacts c
    SET platforms = computed.new_platforms, updated_at = NOW()
    FROM (
      SELECT t.id,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN
            t.full_name ~* 'z(e|s|eus)?\\d*$'
            OR EXISTS (SELECT 1 FROM per_token pt WHERE pt.id = t.id AND pt.clean_tok ~* 'z(e|s|eus)?\\d*$')
            OR EXISTS (
              SELECT 1 FROM casino_players cp
              JOIN per_token pt ON pt.id = t.id AND cp.username_lower = pt.clean_tok
              WHERE cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
            )
          THEN 'zeus' END,
          CASE WHEN
            t.full_name ~* 'b(t|e)?\\d*$'
            OR EXISTS (SELECT 1 FROM per_token pt WHERE pt.id = t.id AND pt.clean_tok ~* 'b(t|e)?\\d*$')
          THEN 'bet30' END
        ], NULL) AS new_platforms
      FROM tokens t
    ) computed
    WHERE c.id = computed.id
      AND c.platforms IS DISTINCT FROM computed.new_platforms
  `)

  // ── 114: Update trigger + backfill platforms con regex simplificada ────────
  // Reemplaza la lógica compleja de 113 con dos UPDATE simples (sin CTEs ni
  // EXISTS complejos): agrega 'zeus' donde falta y 'bet30' donde falta,
  // detectando el patrón en cualquier parte del campo (no solo al final).
  await run('114a: update platforms trigger — simple regex', `
    CREATE OR REPLACE FUNCTION compute_contact_platforms()
    RETURNS trigger AS $$
    DECLARE
      v_is_zeus boolean := false;
      v_full    text;
    BEGIN
      v_full := COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '');
      IF v_full ~* 'z(e|s|eus)?[0-9]*(\/|$)' THEN
        v_is_zeus := true;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM casino_players cp
          JOIN LATERAL unnest(regexp_split_to_array(v_full, '[/ \\t\\n]+')) AS tok ON true
          WHERE LENGTH(tok) > 2
            AND cp.username_lower = LOWER(REGEXP_REPLACE(tok, '^\\([^)]*\\)', '', 'i'))
            AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
        ) INTO v_is_zeus;
      END IF;
      NEW.platforms := ARRAY_REMOVE(ARRAY[
        CASE WHEN v_is_zeus THEN 'zeus' END,
        CASE WHEN v_full ~* 'b(t|e)?[0-9]*(\/|$)' THEN 'bet30' END
      ], NULL);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  // Agrega 'zeus' a contactos que tienen el patrón pero les falta la plataforma
  await run('114b: backfill zeus — regex z/ze/zs en campo o antes de /', `
    UPDATE contacts
    SET platforms = array_append(platforms, 'zeus'),
        updated_at = NOW()
    WHERE (first_name ~* 'z(e|s|eus)?[0-9]*(\/|$)' OR last_name ~* 'z(e|s|eus)?[0-9]*(\/|$)')
      AND NOT ('zeus' = ANY(platforms))
  `)

  // Agrega 'bet30' a contactos que tienen el patrón pero les falta la plataforma
  await run('114c: backfill bet30 — regex b/bt/be en campo o antes de /', `
    UPDATE contacts
    SET platforms = array_append(platforms, 'bet30'),
        updated_at = NOW()
    WHERE (first_name ~* 'b(t|e)?[0-9]*(\/|$)' OR last_name ~* 'b(t|e)?[0-9]*(\/|$)')
      AND NOT ('bet30' = ANY(platforms))
  `)

  // ── 115: Tokenized-regex platform detection ───────────────────────────────────
  // Strips all (xxx) groups, then splits by / and spaces, and checks if any
  // individual token ends with [digit]z(e|s|eus)?[digits] (zeus) or
  // [digit]b(t|e)?[digits] (bet30). The required digit before the letter suffix
  // prevents false positives on real surnames like "Diaz" or "Gonzalez".
  // This catches old players not present in casino_players.
  await run('115a: update trigger — tokenized regex + DB-lookup hybrid', `
    CREATE OR REPLACE FUNCTION compute_contact_platforms()
    RETURNS trigger AS $$
    DECLARE
      v_full    text;
      v_cleaned text;
    BEGIN
      v_full    := COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '');
      v_cleaned := REGEXP_REPLACE(v_full, '\\([^)]*\\)\\s*', '', 'gi');

      NEW.platforms := ARRAY_REMOVE(ARRAY[
        CASE WHEN
          EXISTS (
            SELECT 1 FROM regexp_split_to_table(v_cleaned, '[/ \\t]+') AS tok
            WHERE LENGTH(TRIM(tok)) > 2
              AND LOWER(TRIM(tok)) ~* '[0-9]z(e|s|eus)?[0-9]*$'
          )
          OR EXISTS (
            SELECT 1 FROM casino_players cp
            JOIN LATERAL regexp_split_to_table(v_cleaned, '[/ \\t]+') AS tok ON true
            WHERE LENGTH(TRIM(tok)) > 1
              AND cp.username_lower = LOWER(TRIM(tok))
              AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
          )
        THEN 'zeus' END,
        CASE WHEN
          EXISTS (
            SELECT 1 FROM regexp_split_to_table(v_cleaned, '[/ \\t]+') AS tok
            WHERE LENGTH(TRIM(tok)) > 2
              AND LOWER(TRIM(tok)) ~* '[0-9]b(t|e)?[0-9]*$'
          )
          OR EXISTS (
            SELECT 1 FROM casino_players cp
            JOIN LATERAL regexp_split_to_table(v_cleaned, '[/ \\t]+') AS tok ON true
            WHERE LENGTH(TRIM(tok)) > 1
              AND cp.username_lower = LOWER(TRIM(tok))
              AND cp.agente = ANY(ARRAY['btcuno','btcdos','zeus','zeusroyal','bigwin'])
          )
        THEN 'bet30' END
      ], NULL);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  await run('115b: backfill zeus — tokenized regex', `
    UPDATE contacts c
    SET platforms  = array_append(platforms, 'zeus'),
        updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM regexp_split_to_table(
        REGEXP_REPLACE(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''), '\\([^)]*\\)\\s*', '', 'gi'),
        '[/ \\t]+'
      ) AS tok
      WHERE LENGTH(TRIM(tok)) > 2
        AND LOWER(TRIM(tok)) ~* '[0-9]z(e|s|eus)?[0-9]*$'
    )
    AND NOT ('zeus' = ANY(COALESCE(platforms, ARRAY[]::text[])))
  `)

  await run('115c: backfill bet30 — tokenized regex', `
    UPDATE contacts c
    SET platforms  = array_append(platforms, 'bet30'),
        updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM regexp_split_to_table(
        REGEXP_REPLACE(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''), '\\([^)]*\\)\\s*', '', 'gi'),
        '[/ \\t]+'
      ) AS tok
      WHERE LENGTH(TRIM(tok)) > 2
        AND LOWER(TRIM(tok)) ~* '[0-9]b(t|e)?[0-9]*$'
    )
    AND NOT ('bet30' = ANY(COALESCE(platforms, ARRAY[]::text[])))
  `)

  const failed = results.filter(r => !r.ok)
  return NextResponse.json({
    ok: failed.length === 0,
    results,
    message: failed.length === 0
      ? 'Todas las migraciones aplicadas correctamente'
      : `${failed.length} pasos fallaron`,
  })
}
