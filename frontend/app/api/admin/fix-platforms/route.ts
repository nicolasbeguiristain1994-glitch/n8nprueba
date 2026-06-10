import { NextRequest, NextResponse } from 'next/server'
import { getDbClient } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

/**
 * POST /api/admin/fix-platforms
 *
 * Recomputes the `platforms` column for ALL contacts using regex detection.
 * Disables statement_timeout for this request since the backfill can take
 * more than the default 10s on large tables.
 *
 * Zeus  = username token ending in z/ze/zs/zeus + optional digits, at end of
 *         field or before '/'  (e.g. "Mario46z3/mario46be" → zeus detected from "z3/")
 * Bet30 = username token ending in b/bt/be + optional digits, at end or before '/'
 *         (e.g. "mario46be" → bet30)
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const client = await getDbClient()
  const results: { step: string; ok: boolean; affected?: number; error?: string }[] = []

  try {
    // Disable timeout — backfill on 80k+ contacts can take > 10s
    await client.query('SET statement_timeout = 0')

    // ── Step 1: Update trigger function ────────────────────────────────────────
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION compute_contact_platforms()
        RETURNS trigger AS $$
        DECLARE
          v_is_zeus boolean := false;
          v_full    text;
        BEGIN
          v_full := COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '');

          -- Zeus: pattern z/ze/zs/zeus + optional digits at end or before /
          IF v_full ~* 'z(e|s|eus)?[0-9]*(\/|$)' THEN
            v_is_zeus := true;
          ELSE
            -- Fallback: token-level casino_players lookup (handles f/ff suffix users)
            -- Strip leading parenthesized prefix from each token (e.g. "(C.MUCHO)user99z")
            SELECT EXISTS (
              SELECT 1 FROM casino_players cp
              JOIN LATERAL unnest(regexp_split_to_array(v_full, '[/ ]+')) AS tok ON true
              WHERE LENGTH(tok) > 2
                AND cp.username_lower = LOWER(REGEXP_REPLACE(tok, '^\([^)]*\)', '', 'gi'))
                AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
            ) INTO v_is_zeus;
          END IF;

          NEW.platforms := ARRAY_REMOVE(ARRAY[
            CASE WHEN v_is_zeus                              THEN 'zeus'  END,
            CASE WHEN v_full ~* 'b(t|e)?[0-9]*(\/|$)'      THEN 'bet30' END
          ], NULL);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      results.push({ step: 'trigger_update', ok: true })
    } catch (e) {
      results.push({ step: 'trigger_update', ok: false, error: e instanceof Error ? e.message : String(e) })
    }

    // ── Step 2: Add 'zeus' to contacts missing it ──────────────────────────────
    try {
      const r2 = await client.query(`
        UPDATE contacts
        SET platforms  = array_append(platforms, 'zeus'),
            updated_at = NOW()
        WHERE (first_name ~* 'z(e|s|eus)?[0-9]*(\/|$)' OR last_name ~* 'z(e|s|eus)?[0-9]*(\/|$)')
          AND NOT ('zeus' = ANY(platforms))
      `)
      results.push({ step: 'backfill_zeus', ok: true, affected: r2.rowCount ?? 0 })
    } catch (e) {
      results.push({ step: 'backfill_zeus', ok: false, error: e instanceof Error ? e.message : String(e) })
    }

    // ── Step 3: Add 'bet30' to contacts missing it ─────────────────────────────
    try {
      const r3 = await client.query(`
        UPDATE contacts
        SET platforms  = array_append(platforms, 'bet30'),
            updated_at = NOW()
        WHERE (first_name ~* 'b(t|e)?[0-9]*(\/|$)' OR last_name ~* 'b(t|e)?[0-9]*(\/|$)')
          AND NOT ('bet30' = ANY(platforms))
      `)
      results.push({ step: 'backfill_bet30', ok: true, affected: r3.rowCount ?? 0 })
    } catch (e) {
      results.push({ step: 'backfill_bet30', ok: false, error: e instanceof Error ? e.message : String(e) })
    }

  } finally {
    client.release()
  }

  const failed = results.filter(r => !r.ok)
  return NextResponse.json({
    ok:      failed.length === 0,
    results,
    message: failed.length === 0
      ? 'Plataformas actualizadas correctamente'
      : `${failed.length} pasos fallaron`,
  })
}
