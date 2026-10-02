import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { query } from '@/lib/db'
import { validateSyncRequest } from '@/lib/casino-sync-validation'
import { isCasinoSyncPaused, casinoSyncPausedResponse } from '@/lib/casino-maintenance'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import path from 'path'

/**
 * POST /api/dashboard/casino/sync
 *
 * INICIA una corrida de sync de casino en background y devuelve su run_id.
 * No espera a que termine: el resultado (éxito, parcial, fallo) queda en
 * casino_sync_runs.
 *
 * Query params:
 *   ?platform=zeus|bet30                →  plataforma (default: zeus)
 *   ?desde=YYYY-MM-DD[&hasta=YYYY-MM-DD]→  rango explícito (máx. 366 días; hasta ≤ hoy ART)
 *   (sin desde)                         →  modo --auto: cursor por agente
 *   ?agentes=a,b                        →  subconjunto de agentes (máx. 20)
 *
 * El proceso hijo es scripts/casino-sync-and-segment.js, lanzado con argv
 * explícito (sin shell): la segmentación corre solo si el sync termina con éxito.
 *
 * Requiere rol admin (rol fresco de la DB, no el de la cookie).
 *
 * Variables de entorno requeridas en el servidor (según plataforma):
 *   ZEUS_API_KEY  +  ZEUS_PLAYER_TOKEN                        (token estático)
 *   ZEUS_API_KEY  +  ZEUS_ADMIN_USER + ZEUS_ADMIN_PASSWORD    (auto-login, preferido)
 *   BET30_API_KEY +  BET30_PLAYER_TOKEN                       (token estático)
 *   BET30_API_KEY +  BET30_ADMIN_USER + BET30_ADMIN_PASSWORD  (auto-login, preferido)
 *   DATABASE_URL ya debe estar configurado
 */

const PLATFORM_ENV_VARS: Record<string, {
  keyVar: string
  tokenVar: string
  adminUserVar: string
  adminPassVar: string
}> = {
  zeus:  { keyVar: 'ZEUS_API_KEY',  tokenVar: 'ZEUS_PLAYER_TOKEN',  adminUserVar: 'ZEUS_ADMIN_USER',  adminPassVar: 'ZEUS_ADMIN_PASSWORD'  },
  bet30: { keyVar: 'BET30_API_KEY', tokenVar: 'BET30_PLAYER_TOKEN', adminUserVar: 'BET30_ADMIN_USER', adminPassVar: 'BET30_ADMIN_PASSWORD' },
}

/** Corrida "en curso" = running con heartbeat reciente. Igual que el runner. */
const STALE_AFTER_MINUTES = 10

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01'
}

/** Cierra como fallida una corrida pre-registrada que nunca llegó a ejecutarse. */
async function markLaunchFailure(runId: string, errorCode: string, errorMessage: string): Promise<void> {
  try {
    await query(
      `UPDATE casino_sync_runs
       SET status = 'failed', finished_at = NOW(), heartbeat_at = NOW(),
           error_code = $2, error_message = $3, segmentation_status = 'skipped'
       WHERE run_id = $1 AND status = 'running'`,
      [runId, errorCode, errorMessage],
    )
  } catch (e) {
    console.error('[/api/dashboard/casino/sync] no se pudo registrar el fallo de arranque', (e as { code?: string })?.code)
  }
}

export async function POST(req: Request) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Pausa operativa: después de autenticar, antes de leer credenciales,
  // consultar la base o lanzar procesos.
  if (isCasinoSyncPaused()) return casinoSyncPausedResponse()

  // ── Parámetros ────────────────────────────────────────────────────────────────
  const validation = validateSyncRequest(new URL(req.url).searchParams)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }
  const { platform, mode, desde, hasta, agentes } = validation.value

  // ── Credenciales (solo presencia; nunca se devuelven valores) ────────────────
  const creds       = PLATFORM_ENV_VARS[platform]
  const apiKey      = process.env[creds.keyVar]
  const playerToken = process.env[creds.tokenVar]
  const adminUser   = process.env[creds.adminUserVar]
  const adminPass   = process.env[creds.adminPassVar]

  const hasStaticToken = !!(apiKey && playerToken)
  const hasAutoLogin   = !!(apiKey && adminUser && adminPass)

  if (!hasStaticToken && !hasAutoLogin) {
    return NextResponse.json(
      { error: `Configurar ${creds.keyVar} + ${creds.tokenVar} (o ${creds.adminUserVar} + ${creds.adminPassVar}) en el servidor` },
      { status: 503 },
    )
  }

  // ── Corrida en curso / registro previo ────────────────────────────────────────
  const runId = randomUUID()
  try {
    const running = await query<{ run_id: string }>(
      `SELECT run_id FROM casino_sync_runs
       WHERE platform = $1 AND status = 'running'
         AND heartbeat_at > NOW() - make_interval(mins => $2)
       ORDER BY started_at DESC
       LIMIT 1`,
      [platform, STALE_AFTER_MINUTES],
    )
    if (running.length) {
      return NextResponse.json(
        { error: `Ya hay una corrida de ${platform} en curso`, run_id: running[0].run_id },
        { status: 409 },
      )
    }

    // Pre-registro: instance_id NULL marca "pendiente, sin runner". El runner
    // solo adopta filas así y con los mismos parámetros; nunca una corrida activa.
    await query(
      `INSERT INTO casino_sync_runs
         (run_id, platform, mode, triggered_by, requested_desde, requested_hasta, requested_agents,
          status, started_at, heartbeat_at, segmentation_status, instance_id)
       VALUES ($1, $2, $3, 'api', $4, $5, $6, 'running', NOW(), NOW(), 'pending', NULL)`,
      [runId, platform, mode, desde, hasta, agentes],
    )
  } catch (e) {
    if (isUndefinedTable(e)) {
      return NextResponse.json(
        { error: 'El registro de corridas no existe todavía (migración 125 pendiente)', code: 'MIGRATION_PENDING' },
        { status: 503 },
      )
    }
    console.error('[/api/dashboard/casino/sync POST] registro previo falló', (e as { code?: string })?.code)
    return NextResponse.json({ error: 'No se pudo registrar la corrida' }, { status: 500 })
  }

  // ── Lanzamiento (sin shell: argv explícito) ───────────────────────────────────
  // Los scripts viven en <repo-root>/scripts/ — Next.js corre desde frontend/
  const chainScript = path.resolve(process.cwd(), '..', 'scripts', 'casino-sync-and-segment.js')
  const args = [
    chainScript,
    `--run-id=${runId}`,
    `--platform=${platform}`,
    '--trigger=api',
    ...(mode === 'range' ? [`--desde=${desde}`, `--hasta=${hasta}`] : ['--auto']),
    ...(agentes ? [`--agentes=${agentes.join(',')}`] : []),
  ]

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio:    'ignore',
      env:      process.env,
    })

    child.once('error', err => {
      console.error('[/api/dashboard/casino/sync] spawn falló', (err as NodeJS.ErrnoException).code)
      void markLaunchFailure(runId, 'SPAWN_FAILED', 'No se pudo iniciar el proceso de sync.')
    })
    // Si el hijo sale con error antes de que el runner tome la corrida (argumentos,
    // entorno, crash al arrancar), la fila seguiría "running": se cierra acá.
    // Si el runner ya la cerró, el WHERE status = 'running' no toca nada.
    child.once('exit', code => {
      if (code !== 0 && code !== null) {
        void markLaunchFailure(runId, 'CHILD_EXIT', `El proceso de sync terminó con código ${code} antes de registrar el resultado.`)
      }
    })
    child.unref()

    return NextResponse.json(
      {
        ok:       true,
        run_id:   runId,
        status:   'started',
        platform,
        mode,
        // Solo se confirma el arranque. Cada tramo que termina se guarda al
        // momento, aunque la corrida completa termine parcial o fallida.
        message:  'Solicitud de sincronización aceptada. Los datos se actualizarán cuando termine el proceso.',
      },
      { status: 202 },
    )
  } catch (e) {
    console.error('[/api/dashboard/casino/sync POST] spawn lanzó', (e as NodeJS.ErrnoException)?.code)
    await markLaunchFailure(runId, 'SPAWN_FAILED', 'No se pudo iniciar el proceso de sync.')
    return NextResponse.json({ error: 'No se pudo iniciar el sync', run_id: runId }, { status: 500 })
  }
}
