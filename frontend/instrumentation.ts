/**
 * Next.js instrumentation hook — se ejecuta UNA VEZ al arrancar el servidor.
 * Aplica las columnas de warmup que pueden faltar según qué DB usa la app en producción
 * (el migration runner externo apunta a un host diferente al que inyecta Railway).
 * Todas las sentencias usan ADD COLUMN IF NOT EXISTS → idempotentes, nunca fallan.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    // Importamos dinámicamente para no bloquear el edge runtime
    const { pool } = await import('@/lib/db')
    const client = await pool.connect()
    try {
      await client.query(`
        ALTER TABLE warmup_numbers
          ADD COLUMN IF NOT EXISTS display_name          VARCHAR(100),
          ADD COLUMN IF NOT EXISTS evolution_url         VARCHAR(255),
          ADD COLUMN IF NOT EXISTS delay_preset          VARCHAR(20)     DEFAULT 'normal',
          ADD COLUMN IF NOT EXISTS delay_min_seconds     INTEGER         DEFAULT 45,
          ADD COLUMN IF NOT EXISTS delay_max_seconds     INTEGER         DEFAULT 180,
          ADD COLUMN IF NOT EXISTS sending_window_start  TIME            DEFAULT '09:00',
          ADD COLUMN IF NOT EXISTS sending_window_end    TIME            DEFAULT '22:00',
          ADD COLUMN IF NOT EXISTS active_days           INTEGER[]       DEFAULT '{1,2,3,4,5,6,7}',
          ADD COLUMN IF NOT EXISTS anti_ban_enabled      BOOLEAN         DEFAULT false,
          ADD COLUMN IF NOT EXISTS randomness_level      VARCHAR(10)     DEFAULT 'medium',
          ADD COLUMN IF NOT EXISTS natural_distribution  BOOLEAN         DEFAULT false
      `)
      console.log('[instrumentation] warmup_numbers columns verified/applied')
    } finally {
      client.release()
    }
  } catch (e) {
    // No lanzamos — si warmup_numbers no existe todavía está bien, se creará luego
    console.warn('[instrumentation] warmup schema check skipped:', e instanceof Error ? e.message : e)
  }
}
