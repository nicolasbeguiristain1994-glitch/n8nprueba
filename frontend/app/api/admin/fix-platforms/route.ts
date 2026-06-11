import { NextRequest, NextResponse } from 'next/server'
import { getLongRunningClient } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

// Strip all (xxx) groups, then tokenize by / space tab, match against casino_players
const TOKEN_JOIN = (agentes: string[]) => `
  EXISTS (
    SELECT 1 FROM casino_players cp
    JOIN LATERAL regexp_split_to_table(
      REGEXP_REPLACE(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''), '\\([^)]*\\)\\s*', '', 'gi'),
      '[/ \\t]+'
    ) AS tok ON true
    WHERE LENGTH(TRIM(tok)) > 1
      AND cp.username_lower = LOWER(TRIM(tok))
      AND cp.agente = ANY(ARRAY[${agentes.map(a => `'${a}'`).join(',')}])
  )
`

const ZEUS_AGENTS  = ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet']
const BET30_AGENTS = ['btcuno', 'btcdos', 'zeus', 'zeusroyal', 'bigwin']

async function runFixPlatforms() {
  const client = await getLongRunningClient()
  const results: { step: string; ok: boolean; affected?: number; error?: string }[] = []

  async function run(step: string, sql: string) {
    try {
      const res = await client.query(sql)
      results.push({ step, ok: true, affected: res.rowCount ?? 0 })
    } catch (e) {
      results.push({ step, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  try {
    // Step 1: Update trigger with full DB-lookup logic for both platforms
    await run('trigger_update', `
      CREATE OR REPLACE FUNCTION compute_contact_platforms()
      RETURNS trigger AS $$
      DECLARE
        v_full    text;
        v_cleaned text;
      BEGIN
        v_full    := COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '');
        v_cleaned := REGEXP_REPLACE(v_full, '\\([^)]*\\)\\s*', '', 'gi');

        NEW.platforms := ARRAY_REMOVE(ARRAY[
          CASE WHEN EXISTS (
            SELECT 1 FROM casino_players cp
            JOIN LATERAL regexp_split_to_table(v_cleaned, '[/ \\t]+') AS tok ON true
            WHERE LENGTH(TRIM(tok)) > 1
              AND cp.username_lower = LOWER(TRIM(tok))
              AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
          ) THEN 'zeus' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM casino_players cp
            JOIN LATERAL regexp_split_to_table(v_cleaned, '[/ \\t]+') AS tok ON true
            WHERE LENGTH(TRIM(tok)) > 1
              AND cp.username_lower = LOWER(TRIM(tok))
              AND cp.agente = ANY(ARRAY['btcuno','btcdos','zeus','zeusroyal','bigwin'])
          ) THEN 'bet30' END
        ], NULL);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)

    // Step 2: Backfill zeus via DB lookup (catches fa/fe/f suffixes y todos los agentes)
    await run('backfill_zeus_db', `
      UPDATE contacts c
      SET platforms  = array_append(platforms, 'zeus'),
          updated_at = NOW()
      WHERE ${TOKEN_JOIN(ZEUS_AGENTS)}
        AND NOT ('zeus' = ANY(platforms))
    `)

    // Step 3: Backfill bet30 via DB lookup
    await run('backfill_bet30_db', `
      UPDATE contacts c
      SET platforms  = array_append(platforms, 'bet30'),
          updated_at = NOW()
      WHERE ${TOKEN_JOIN(BET30_AGENTS)}
        AND NOT ('bet30' = ANY(platforms))
    `)

  } finally {
    await client.end()
  }

  const failed = results.filter(r => !r.ok)
  console.log('[fix-platforms background]', failed.length === 0 ? 'OK' : `${failed.length} pasos fallaron`, results)
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  // Corre en background para evitar timeout HTTP
  void runFixPlatforms()

  return NextResponse.json({
    ok:      true,
    message: 'Fix de plataformas iniciado en background (~2-3 minutos).',
  })
}
