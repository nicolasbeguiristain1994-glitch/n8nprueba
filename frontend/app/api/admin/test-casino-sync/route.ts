import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { isValidSyncPlatform } from '@/lib/casino-agents'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

/**
 * GET /api/admin/test-casino-sync?platform=zeus
 * Corre el sync en foreground (no detached) y captura stdout/stderr.
 * Solo para diagnóstico — timeout de 30 segundos.
 *
 * Fase 4 fix: este endpoint reutiliza scripts/sync-casino-players-live.js con
 * --auto, así que hereda el mismo advisory lock por plataforma que el botón
 * manual y el cron — un diagnóstico corrido mientras un sync real está en
 * curso sale limpio (skip), nunca corrompe nada.
 *
 * Bug corregido acá (auditoría fase 4): antes SIEMPRE respondía `ok: true`
 * incluso cuando el proceso hijo salía con código != 0 o hacía timeout (el
 * único chequeo real era si `spawn()` tiraba sincrónicamente, cosa que casi
 * nunca pasa) y usaba `spawn('node', ...)` — dependía de que "node" existiera
 * en el PATH del proceso, en vez de `process.execPath` (el mismo binario que
 * corre este server). También aceptaba cualquier string como `platform` sin
 * validar contra las 4 plataformas soportadas.
 */
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const platform = req.nextUrl.searchParams.get('platform') || 'zeus'
  if (!isValidSyncPlatform(platform)) {
    return NextResponse.json(
      { ok: false, error: `Plataforma inválida: "${platform}". Valores permitidos: zeus, bet30, ganamos, argenbet` },
      { status: 400 },
    )
  }

  const scriptsDir = path.resolve(process.cwd(), '..', 'scripts')
  const syncScript = path.join(scriptsDir, 'sync-casino-players-live.js')

  const diagnostics: Record<string, unknown> = {
    cwd:        process.cwd(),
    scriptsDir,
    syncScript,
    scriptExists: fs.existsSync(syncScript),
    platform,
    env: {
      ZEUS_API_KEY:        !!process.env.ZEUS_API_KEY,
      ZEUS_ADMIN_USER:     !!process.env.ZEUS_ADMIN_USER,
      ZEUS_ADMIN_PASSWORD: !!process.env.ZEUS_ADMIN_PASSWORD,
      BET30_API_KEY:       !!process.env.BET30_API_KEY,
      BET30_ADMIN_USER:    !!process.env.BET30_ADMIN_USER,
      BET30_ADMIN_PASSWORD:!!process.env.BET30_ADMIN_PASSWORD,
      DATABASE_URL:        !!process.env.DATABASE_URL,
    },
  }

  if (!diagnostics.scriptExists) {
    return NextResponse.json({ ok: false, diagnostics, error: 'Script no encontrado en el container' })
  }

  const output = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError: string | null }>((resolve) => {
    const lines: string[] = []
    const errLines: string[] = []
    let settled = false

    // process.execPath: the exact Node binary running this server, never a
    // "node" resolved from the child's PATH (which may not have one at all
    // in a minimal container).
    const child = spawn(process.execPath, [syncScript, `--platform=${platform}`, '--auto'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   process.env,
    })

    child.stdout?.on('data', (d: Buffer) => {
      const line = d.toString()
      lines.push(line)
      if (lines.join('').length > 8000) child.kill()
    })
    child.stderr?.on('data', (d: Buffer) => errLines.push(d.toString()))

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ stdout: lines.join('').slice(0, 8000), stderr: errLines.join('').slice(0, 2000), code: null, timedOut: true, spawnError: null })
    }, 30_000)

    // spawn() can fail ASYNCHRONOUSLY (e.g. ENOENT) — a try/catch around
    // spawn() would never see it. Must be handled here, not assumed away.
    child.on('error', (spawnErr) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: lines.join('').slice(0, 8000), stderr: errLines.join('').slice(0, 2000), code: null, timedOut: false, spawnError: spawnErr.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: lines.join('').slice(0, 8000), stderr: errLines.join('').slice(0, 2000), code, timedOut: false, spawnError: null })
    })
  })

  // Fase 4 fix: never report a failed/timed-out/unlaunchable sync as ok:true.
  // `code === 0` is the ONLY success condition — null (timeout or still
  // running when killed) and any non-zero code are failures, and a spawn
  // error means the process never even started.
  const ok = output.spawnError === null && !output.timedOut && output.code === 0

  return NextResponse.json({ ok, diagnostics, output }, { status: ok ? 200 : 502 })
}
