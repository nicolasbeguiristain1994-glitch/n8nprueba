import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

/**
 * GET /api/admin/test-casino-sync?platform=zeus
 * Corre el sync en foreground (no detached) y captura stdout/stderr.
 * Solo para diagnóstico — timeout de 30 segundos.
 */
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const platform = req.nextUrl.searchParams.get('platform') || 'zeus'
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

  const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const lines: string[] = []
    const errLines: string[] = []

    const child = spawn('node', [syncScript, `--platform=${platform}`, '--auto'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env, PATH: process.env.PATH ?? '' },
    })

    child.stdout?.on('data', (d: Buffer) => {
      const line = d.toString()
      lines.push(line)
      if (lines.join('').length > 8000) child.kill()
    })
    child.stderr?.on('data', (d: Buffer) => errLines.push(d.toString()))

    const timer = setTimeout(() => {
      child.kill()
      resolve({ stdout: lines.join('').slice(0, 8000) + '\n[timeout 30s]', stderr: errLines.join(''), code: null })
    }, 30_000)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: lines.join('').slice(0, 8000), stderr: errLines.join('').slice(0, 2000), code })
    })
  })

  return NextResponse.json({ ok: true, diagnostics, output })
}
