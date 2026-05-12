import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { isValidPlatform } from '@/lib/casino-agents'
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
 *   ?platform=zeus|bet30                →  plataforma a sincronizar (default: zeus)
 *   ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD  →  rango explícito
 *   (sin desde/hasta)                   →  modo --auto (incremental)
 *
 * Requiere rol admin.
 *
 * Variables de entorno requeridas en el servidor (según plataforma):
 *   ZEUS_API_KEY, ZEUS_PLAYER_TOKEN     (para zeus)
 *   BET30_API_KEY, BET30_PLAYER_TOKEN   (para bet30)
 *   DATABASE_URL ya debe estar configurado
 */

const PLATFORM_ENV_VARS: Record<string, { keyVar: string; tokenVar: string }> = {
  zeus:  { keyVar: 'ZEUS_API_KEY',  tokenVar: 'ZEUS_PLAYER_TOKEN'  },
  bet30: { keyVar: 'BET30_API_KEY', tokenVar: 'BET30_PLAYER_TOKEN' },
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  // Solo admins pueden disparar sincronizaciones
  const { getSessionFromRequest } = await import('@/lib/auth')
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Plataforma ────────────────────────────────────────────────────────────────
  const platformParam = req.nextUrl.searchParams.get('platform')?.trim() || 'zeus'

  if (!isValidPlatform(platformParam)) {
    return NextResponse.json(
      { error: `Plataforma inválida: "${platformParam}". Valores permitidos: zeus, bet30` },
      { status: 400 },
    )
  }

  const creds = PLATFORM_ENV_VARS[platformParam]
  const apiKey      = process.env[creds.keyVar]
  const playerToken = process.env[creds.tokenVar]

  if (!apiKey || !playerToken) {
    return NextResponse.json(
      { error: `Variables ${creds.keyVar} y ${creds.tokenVar} no configuradas en el servidor` },
      { status: 503 },
    )
  }

  // ── Rango de fechas ───────────────────────────────────────────────────────────
  const desde = req.nextUrl.searchParams.get('desde')
  const hasta  = req.nextUrl.searchParams.get('hasta')

  // Los scripts viven en <repo-root>/scripts/ — Next.js corre desde frontend/
  const scriptsDir = path.resolve(process.cwd(), '..', 'scripts')
  const syncScript = path.join(scriptsDir, 'sync-casino-players-live.js')
  const segScript  = path.join(scriptsDir, 'segmentar-casino-players.js')

  const syncArgs = desde
    ? [`--platform=${platformParam}`, `--desde=${desde}`, ...(hasta ? [`--hasta=${hasta}`] : [])]
    : [`--platform=${platformParam}`, '--auto']

  // Encadena sync → segmentación: la segmentación solo corre si el sync termina OK.
  // Se lanza en un proceso detached para no bloquear la respuesta HTTP.
  const chainCmd = [
    'node', syncScript, ...syncArgs,
    '&&',
    'node', segScript,
  ].join(' ')

  try {
    const child = spawn('sh', ['-c', chainCmd], {
      detached: true,
      stdio:    'ignore',
      env: {
        ...process.env,
        [creds.keyVar]:   apiKey,
        [creds.tokenVar]: playerToken,
        PATH:             process.env.PATH ?? '',
      },
    })

    child.unref()

    const platformLabel = platformParam === 'bet30' ? 'Bet30' : 'Zeus'

    return NextResponse.json({
      ok:       true,
      platform: platformParam,
      message:  desde
        ? `Sync ${platformLabel} iniciado para el rango ${desde} → ${hasta ?? 'hoy'}. Los datos (con segmentación) se actualizarán en ~5 minutos.`
        : `Sync incremental ${platformLabel} + segmentación iniciados (--auto). Los datos se actualizarán en ~5 minutos.`,
      pid:  child.pid,
      mode: desde ? 'range' : 'auto',
    })
  } catch (e) {
    console.error('[/api/dashboard/casino/sync POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo iniciar el sync' }, { status: 500 })
  }
}
