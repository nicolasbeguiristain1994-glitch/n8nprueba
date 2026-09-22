import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { isValidSyncPlatform, getAgentsForPlatform } from '@/lib/casino-agents'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'

/**
 * POST /api/dashboard/casino/sync
 *
 * Lanza sync-casino-players-live.js en background (detached) y retorna
 * inmediatamente. Con --auto el script detecta la última fecha cargada en
 * casino_transactions y sincroniza desde ahí hasta hoy.
 *
 * Query params:
 *   ?platform=zeus|bet30|ganamos|argenbet →  plataforma a sincronizar (default: zeus)
 *   ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD    →  rango explícito
 *   (sin desde/hasta)                     →  modo --auto (incremental)
 *
 * Requiere rol admin.
 *
 * Variables de entorno requeridas en el servidor (según plataforma — H4 fix:
 * antes solo zeus/bet30 estaban modeladas y elegir ganamos/argenbet tiraba un
 * TypeError sin mensaje útil):
 *   ZEUS_API_KEY  +  ZEUS_PLAYER_TOKEN                        (token estático)
 *   ZEUS_API_KEY  +  ZEUS_ADMIN_USER + ZEUS_ADMIN_PASSWORD    (auto-login, preferido)
 *   BET30_API_KEY +  BET30_PLAYER_TOKEN                       (token estático)
 *   BET30_API_KEY +  BET30_ADMIN_USER + BET30_ADMIN_PASSWORD  (auto-login, preferido)
 *   ARGENBET_PLAYER_TOKEN                                     (token estático temporal —
 *     el endpoint de login todavía no está confirmado, ver plan H10/§Fase 2)
 *   ARGENBET_ADMIN_USER + ARGENBET_ADMIN_PASSWORD             (auto-login — TODO, no inventado)
 *   GANAMOS_<AGENTE>_SESSION_COOKIE                            (por agente, atajo de desarrollo —
 *     el login real todavía no está confirmado, ver GanamosConnector._loginAgent() y plan Fase 3)
 *   GANAMOS_<AGENTE>_USER + GANAMOS_<AGENTE>_PASSWORD         (por agente — Ganamos no tiene
 *     un token único: cada agente tiene su propia sesión, ver plan Fase 3. Alcanza con al
 *     menos un agente configurado para habilitar el botón manual. Sin un loginAdapter real
 *     inyectado, este par por sí solo todavía no alcanza para sincronizar ese agente.)
 *   DATABASE_URL ya debe estar configurado
 *
 * NOTA: los 4 conectores (Zeus/Bet30/Argenbet/Ganamos) ya están implementados (fase 1-3 del
 * plan). El login HTTP real de Argenbet y Ganamos sigue sin confirmar — con solo credenciales
 * de usuario/contraseña y sin un loginAdapter inyectado, ese agente/plataforma falla de forma
 * visible en el log del proceso hijo al primer intento de login, nunca como un 500 silencioso
 * ni bloqueando a otras plataformas o agentes.
 */

type SyncPlatform = 'zeus' | 'bet30' | 'ganamos' | 'argenbet'

function checkZeusLikeCredentials(prefix: 'ZEUS' | 'BET30') {
  const apiKey    = process.env[`${prefix}_API_KEY`]
  const token     = process.env[`${prefix}_PLAYER_TOKEN`]
  const adminUser = process.env[`${prefix}_ADMIN_USER`]
  const adminPass = process.env[`${prefix}_ADMIN_PASSWORD`]
  return {
    ok:   !!(apiKey && token) || !!(apiKey && adminUser && adminPass),
    hint: `Configurar ${prefix}_API_KEY + ${prefix}_PLAYER_TOKEN (o ${prefix}_ADMIN_USER + ${prefix}_ADMIN_PASSWORD) en el servidor`,
  }
}

// Bearer JWT, no X-Api-Key (a diferencia de Zeus/Bet30) — ver plan §3.
function checkArgenbetCredentials() {
  const token     = process.env.ARGENBET_PLAYER_TOKEN
  const adminUser = process.env.ARGENBET_ADMIN_USER
  const adminPass = process.env.ARGENBET_ADMIN_PASSWORD
  return {
    ok:   !!token || !!(adminUser && adminPass),
    hint: 'Configurar ARGENBET_PLAYER_TOKEN (token estático temporal) o ARGENBET_ADMIN_USER + ARGENBET_ADMIN_PASSWORD en el servidor (login automático aún no implementado — ver docs/PLAN-METRICAS-4-PLATAFORMAS.md H10)',
  }
}

// Una sesión (cookie) por agente, no un token de plataforma — ver plan Fase 3
// y GanamosConnector. GANAMOS_<AGENTE>_SESSION_COOKIE es el atajo temporal de
// desarrollo (sin login real capturado todavía); USER+PASSWORD requiere un
// loginAdapter inyectado que hoy no existe en producción, pero se acepta acá
// igual porque GanamosConnector es quien decide en el momento del sync si
// puede usarlo — este check solo habilita el botón manual.
function checkGanamosCredentials() {
  const configurados = getAgentsForPlatform('ganamos').filter(agente => {
    const key = agente.toUpperCase()
    return !!process.env[`GANAMOS_${key}_SESSION_COOKIE`] ||
      !!(process.env[`GANAMOS_${key}_USER`] && process.env[`GANAMOS_${key}_PASSWORD`])
  })
  return {
    ok:   configurados.length > 0,
    hint: 'Configurar al menos GANAMOS_<AGENTE>_SESSION_COOKIE (desarrollo) o GANAMOS_<AGENTE>_USER + GANAMOS_<AGENTE>_PASSWORD en el servidor (Ganamos no tiene un token único — credenciales por agente, ver docs/PLAN-METRICAS-4-PLATAFORMAS.md Fase 3)',
  }
}

function checkCredentials(platform: SyncPlatform): { ok: boolean; hint: string } {
  switch (platform) {
    case 'zeus':     return checkZeusLikeCredentials('ZEUS')
    case 'bet30':    return checkZeusLikeCredentials('BET30')
    case 'argenbet': return checkArgenbetCredentials()
    case 'ganamos':  return checkGanamosCredentials()
  }
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

  if (!isValidSyncPlatform(platformParam)) {
    return NextResponse.json(
      { error: `Plataforma inválida para sync: "${platformParam}". Valores permitidos: zeus, bet30, ganamos, argenbet` },
      { status: 400 },
    )
  }

  const { ok: hasCredentials, hint } = checkCredentials(platformParam)
  if (!hasCredentials) {
    return NextResponse.json({ error: hint }, { status: 503 })
  }

  // ── Rango de fechas ───────────────────────────────────────────────────────────
  const desde = req.nextUrl.searchParams.get('desde')
  const hasta  = req.nextUrl.searchParams.get('hasta')

  if (desde && !isValidCalendarDate(desde)) {
    return NextResponse.json({ error: `desde inválido: "${desde}" (esperado YYYY-MM-DD)` }, { status: 400 })
  }
  if (hasta && !isValidCalendarDate(hasta)) {
    return NextResponse.json({ error: `hasta inválido: "${hasta}" (esperado YYYY-MM-DD)` }, { status: 400 })
  }
  if (desde && hasta && desde > hasta) {
    // Sin esto, sync-casino-players-live.js recibe un rango vacío y termina con
    // "Sync run complete" / exit 0 sin haber sincronizado nada — un fallo
    // silencioso indistinguible de un sync exitoso.
    return NextResponse.json({ error: `desde (${desde}) no puede ser posterior a hasta (${hasta})` }, { status: 400 })
  }

  // Los scripts viven en <repo-root>/scripts/ — Next.js corre desde frontend/
  const scriptsDir      = path.resolve(process.cwd(), '..', 'scripts')
  const supervisorScript = path.join(scriptsDir, 'casino-sync-then-segment.js')

  const agentesParam = req.nextUrl.searchParams.get('agentes')?.trim()

  const syncArgs = desde
    ? [
        `--platform=${platformParam}`,
        `--desde=${desde}`,
        ...(hasta    ? [`--hasta=${hasta}`]         : []),
        ...(agentesParam ? [`--agentes=${agentesParam}`] : []),
      ]
    : [
        `--platform=${platformParam}`,
        '--auto',
        ...(agentesParam ? [`--agentes=${agentesParam}`] : []),
      ]

  // Se lanza UN wrapper (scripts/casino-sync-then-segment.js) que supervisa
  // sync → segmentación internamente, en vez de encadenar los dos scripts desde
  // esta misma ruta con un `child.on('exit', …)`. Encadenarlos acá dependería de
  // que el proceso de Next.js siguiera vivo cuando el sync termine (minutos
  // después) — válido en la práctica mientras el server no se reinicie en el
  // medio, pero no es una garantía real de continuidad. El wrapper es el único
  // proceso detached, y esta ruta solo necesita confirmar que llegó a arrancar.
  //
  // `spawn()` con argumentos (nunca `sh -c`) evita interpolar desde/hasta/agentes
  // —que vienen de query params— en una shell string. `process.execPath` usa el
  // mismo binario de Node que corre este server, no un "node" del PATH que podría
  // no existir. El spawn puede fallar de forma ASÍNCRONA (evento 'error', p.ej.
  // ENOENT si el binario no está) — un try/catch alrededor de spawn() no lo
  // detecta; hay que esperar el primer evento ('spawn' o 'error') antes de
  // responder 200.
  function spawnAndConfirm(script: string, args: string[]): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        detached: true,
        stdio:    'ignore',
        env:      process.env,
      })
      child.once('error', reject)
      child.once('spawn', () => resolve(child))
    })
  }

  try {
    const child = await spawnAndConfirm(supervisorScript, ['--', ...syncArgs])
    child.unref()

    const platformLabel = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }[platformParam]

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

/** YYYY-MM-DD y fecha de calendario real (rechaza 2025-02-30, etc.). */
function isValidCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
