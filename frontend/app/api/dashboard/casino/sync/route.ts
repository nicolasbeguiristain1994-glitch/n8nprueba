import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { spawn } from 'child_process'
import path from 'path'

/**
 * POST /api/dashboard/casino/sync
 *
 * Lanza sync-casino-players-live.js en background (detached) y retorna
 * inmediatamente. El cliente puede re-fetchear los datos de casino después
 * de unos minutos para ver los resultados actualizados.
 *
 * Requiere rol admin.
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  // Solo admins pueden disparar un sync completo con Zeus
  const { getSessionFromRequest } = await import('@/lib/auth')
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // El script vive en <repo-root>/scripts/ — Next.js corre desde frontend/
    const scriptPath = path.resolve(process.cwd(), '..', 'scripts', 'sync-casino-players-live.js')

    const child = spawn('node', [scriptPath], {
      detached: true,
      stdio:    'ignore',
      env: {
        ...process.env,
        // Asegura que el PATH del sistema esté disponible
        PATH: process.env.PATH,
      },
    })

    child.unref() // desvincula del proceso padre — continúa en background

    return NextResponse.json({
      ok:      true,
      message: 'Sync iniciado en background. Los datos se actualizarán en ~2 minutos.',
      pid:     child.pid,
    })
  } catch (e) {
    console.error('[/api/dashboard/casino/sync POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo iniciar el sync' }, { status: 500 })
  }
}
