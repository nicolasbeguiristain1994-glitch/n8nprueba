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

  const failed = results.filter(r => !r.ok)
  return NextResponse.json({
    ok: failed.length === 0,
    results,
    message: failed.length === 0
      ? 'Todas las migraciones aplicadas correctamente'
      : `${failed.length} pasos fallaron`,
  })
}
