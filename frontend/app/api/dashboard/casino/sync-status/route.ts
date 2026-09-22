import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { SYNC_PLATFORMS, getAgentsForPlatform } from '@/lib/casino-agents'

interface RunRow {
  platform:     string
  agente:       string | null
  status:       string
  started_at:   string
  finished_at:  string | null
  tx_inserted:  number | null
  error:        string | null
}

/**
 * GET /api/dashboard/casino/sync-status
 *
 * Fase 4 (D4, "casino_sync_runs para que un sync caído sea visible"):
 * último estado real de sincronización por (platform, agente), leído de
 * `casino_sync_runs` (migración 128). No rediseña el dashboard — es un
 * endpoint de solo lectura para que la UI existente pueda pintar un badge
 * running/ok/error por plataforma sin adivinar nada a partir de
 * MAX(fecha_hora_utc).
 *
 * - `status='skipped'` se excluye del cálculo de "último estado real" — un
 *   skip nunca debe tapar el último éxito o error genuino — pero se expone
 *   aparte (`lastSkipAt`) para diagnóstico.
 * - `agente IS NULL` filas son el run PADRE a nivel de plataforma (ver
 *   `scripts/lib/casino-sync-orchestrator.js`: cubre desde antes de crear el
 *   conector hasta después del último agente) — se exponen por separado
 *   como `platformRun`, nunca mezcladas en la lista `agents`.
 * - Todo agente configurado (`getAgentsForPlatform`) aparece en `agents`
 *   aunque nunca haya corrido — con `status: 'never_synced'`, no omitido en
 *   silencio.
 * - `lastSuccessfulAt` por agente: MAX(finished_at) de sus runs 'ok' — así
 *   un agente actualmente `failed` todavía muestra cuándo fue la última vez
 *   que sí sincronizó, en vez de perder esa información.
 * - Empate de `started_at` en `DISTINCT ON` se desempata por `id DESC`
 *   (dos runs no pueden tener el mismo id, a diferencia de un timestamp con
 *   el clock mockeado/de baja resolución en tests).
 */
export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  try {
    const [latestPerAgent, lastSuccessPerAgent, skipRuns, latestParentPerPlatform] = await Promise.all([
      query<RunRow>(
        `SELECT DISTINCT ON (platform, agente)
           platform, agente, status, started_at, finished_at, tx_inserted, error
         FROM casino_sync_runs
         WHERE status != 'skipped' AND agente IS NOT NULL
         ORDER BY platform, agente, started_at DESC, id DESC`,
      ),
      query<{ platform: string; agente: string; finished_at: string }>(
        `SELECT platform, agente, MAX(finished_at) AS finished_at
         FROM casino_sync_runs
         WHERE status = 'ok' AND agente IS NOT NULL
         GROUP BY platform, agente`,
      ),
      query<{ platform: string; started_at: string }>(
        `SELECT DISTINCT ON (platform) platform, started_at
         FROM casino_sync_runs
         WHERE status = 'skipped'
         ORDER BY platform, started_at DESC, id DESC`,
      ),
      query<RunRow>(
        `SELECT DISTINCT ON (platform)
           platform, agente, status, started_at, finished_at, tx_inserted, error
         FROM casino_sync_runs
         WHERE status != 'skipped' AND agente IS NULL
         ORDER BY platform, started_at DESC, id DESC`,
      ),
    ])

    const lastSkipByPlatform    = Object.fromEntries(skipRuns.map((r) => [r.platform, r.started_at]))
    const lastSuccessByKey      = new Map(lastSuccessPerAgent.map((r) => [`${r.platform}:${r.agente}`, r.finished_at]))
    const latestByKey           = new Map(latestPerAgent.map((r) => [`${r.platform}:${r.agente}`, r]))
    const parentByPlatform      = Object.fromEntries(latestParentPerPlatform.map((r) => [r.platform, r]))

    const platforms = Object.fromEntries(
      SYNC_PLATFORMS.map((platform) => {
        const configuredAgents = getAgentsForPlatform(platform)
        const agents = configuredAgents.map((agente) => {
          const key    = `${platform}:${agente}`
          const latest = latestByKey.get(key)
          return {
            agente,
            status:           latest?.status ?? 'never_synced',
            startedAt:        latest?.started_at ?? null,
            finishedAt:       latest?.finished_at ?? null,
            txInserted:       latest?.tx_inserted ?? null,
            error:            latest?.error ?? null,
            lastSuccessfulAt: lastSuccessByKey.get(key) ?? null,
          }
        })

        const parent = parentByPlatform[platform]

        return [platform, {
          platformRun: parent ? {
            status:     parent.status,
            startedAt:  parent.started_at,
            finishedAt: parent.finished_at,
            txInserted: parent.tx_inserted,
            error:      parent.error,
          } : null,
          agents,
          lastSkipAt: lastSkipByPlatform[platform] ?? null,
        }]
      }),
    )

    return NextResponse.json({ platforms })
  } catch (e) {
    // 42P01 = undefined_table (Postgres error code) — migración 128 no
    // aplicada todavía. Chequeo por CÓDIGO, no por texto del mensaje: un
    // error de permisos o un bug de query distintos también pueden
    // mencionar "casino_sync_runs" en su mensaje sin ser "la tabla no
    // existe", y reportarlo como tal sería engañoso.
    const code = (e as { code?: string })?.code
    if (code === '42P01') {
      return NextResponse.json(
        { error: 'casino_sync_runs no existe — aplicar db/migrations/128_casino_sync_runs.sql' },
        { status: 503 },
      )
    }
    const message = e instanceof Error ? e.message : String(e)
    console.error('[/api/dashboard/casino/sync-status GET]', message)
    return NextResponse.json({ error: 'No se pudo leer el estado de sincronización' }, { status: 500 })
  }
}
