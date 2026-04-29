import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { spawn } from 'child_process'
import path from 'path'

/**
 * POST /api/dashboard/casino/sync
 *
 * Lanza sync-casino-players-live.js en background (detached) y retorna
 * inmediatamente. Con --auto el script detecta la última fecha cargada en
 * casino_transactions y sincroniza desde ahí hasta hoy.
 *
 * Query params:
 *   ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD  →  rango explícito
 *   (sin params)                         →  modo --auto (incremental)
 *
 * Requiere rol admin.
 *
 * Variables de entorno requeridas en el servidor:
 *   ZEUS_API_KEY, ZEUS_PLAYER_TOKEN  (DATABASE_URL ya está configurado)
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  // Solo admins pueden disparar sincronizaciones con Zeus
  const { getSessionFromRequest } = await import('@/lib/auth')
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const apiKey      = process.env.ZEUS_API_KEY
  const playerToken = process.env.ZEUS_PLAYER_TOKEN

  if (!apiKey || !playerToken) {
    return NextResponse.json(
      { error: 'Variables ZEUS_API_KEY y ZEUS_PLAYER_TOKEN no configuradas en el servidor' },
      { status: 503 },
    )
  }

  const desde = req.nextUrl.searchParams.get('desde')
  const hasta  = req.nextUrl.searchParams.get('hasta')

  // El script vive en <repo-root>/scripts/ — Next.js corre desde frontend/
  const scriptPath = path.resolve(process.cwd(), '..', 'scripts', 'sync-casino-players-live.js')

  const scriptArgs = desde
    ? [`--desde=${desde}`, ...(hasta ? [`--hasta=${hasta}`] : [])]
    : ['--auto']

  try {
    const child = spawn('node', [scriptPath, ...scriptArgs], {
      detached: true,
      stdio:    'ignore',
      env: {
        ...process.env,
        ZEUS_API_KEY:      apiKey,
        ZEUS_PLAYER_TOKEN: playerToken,
        PATH:              process.env.PATH ?? '',
      },
    })

    child.unref()

    return NextResponse.json({
      ok:      true,
      message: desde
        ? `Sync iniciado para el rango ${desde} → ${hasta ?? 'hoy'}. Los datos se actualizarán en ~2 minutos.`
        : 'Sync incremental iniciado (--auto). Los datos se actualizarán en ~2 minutos.',
      pid:  child.pid,
      mode: desde ? 'range' : 'auto',
    })
  } catch (e) {
    console.error('[/api/dashboard/casino/sync POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo iniciar el sync' }, { status: 500 })
  }
}
