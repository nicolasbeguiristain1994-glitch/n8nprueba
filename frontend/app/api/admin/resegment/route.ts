import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { spawn } from 'child_process'
import path from 'path'

/**
 * POST /api/admin/resegment
 *
 * Lanza segmentar-casino-players.js en background (proceso detached).
 * No bloquea — retorna inmediatamente. El script recalcula seg_monto y
 * seg_actividad usando casino_transactions como fuente de verdad, luego
 * sincroniza contacts.segment y contact_tags.
 *
 * Solo admin.
 */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const { getSessionFromRequest } = await import('@/lib/auth')
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const scriptsDir = path.resolve(process.cwd(), '..', 'scripts')
  const segScript  = path.join(scriptsDir, 'segmentar-casino-players.js')

  try {
    const child = spawn('node', [segScript], {
      detached: true,
      stdio:    ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH ?? '' },
    })

    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[segmentar] ${d}`))
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[segmentar ERR] ${d}`))
    child.on('error', (err: Error) => console.error('[segmentar spawn error]', err.message))
    // El spawn casi nunca falla: los errores reales (DATABASE_URL ausente, valor
    // de enum inexistente) aparecen recién en el exit code, cuando ya
    // respondimos ok:true. Sin este log, una corrida que abortó a los 2 segundos
    // se ve igual que una exitosa y el usuario queda esperando datos que no van
    // a llegar.
    child.on('exit', (code: number | null) => {
      if (code === 0) console.log('[segmentar] completado OK')
      else console.error(`[segmentar] FALLÓ con exit code ${code} — la segmentación NO se aplicó`)
    })
    child.unref()

    return NextResponse.json({
      ok:      true,
      pid:     child.pid,
      message: 'Re-segmentación iniciada en background. Los datos se actualizarán en ~2 minutos.',
    })
  } catch (e) {
    console.error('[/api/admin/resegment]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo iniciar el script' }, { status: 500 })
  }
}
