import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { spawn } from 'child_process'
import path from 'path'

const CHILD_TIMEOUT_MS = 9 * 60 * 1000 // 9 min — under n8n's 10-min node timeout (WF-030), so a timeout here is reported cleanly instead of racing n8n's own cutoff
const STDOUT_BUFFER_LIMIT = 256 * 1024 // pipeline-diario.js can log a lot for a large historical run — never buffer unbounded

/**
 * POST /api/cron/casino-sync
 *
 * Fase 4 (D4, "un solo mecanismo de disparo"): el ÚNICO trigger programado de
 * las 4 sincronizaciones de casino. `n8n/workflow-specs/WF-030-Casino-Daily-Sync.json`
 * llama a este endpoint cada 15 minutos — no llama a
 * `POST /api/dashboard/casino/sync`, que queda reservado exclusivamente para
 * el botón manual del dashboard. Ambas rutas terminan sincronizando a través
 * del mismo advisory lock por plataforma (scripts/lib/casino-sync-orchestrator.js),
 * así que nunca pueden pisarse aunque disparen al mismo tiempo.
 *
 * Auth: header `x-cron-secret` comparado contra `CRON_SECRET` (la misma
 * variable que ya protege `/api/contacts/recompute-priorities`) con
 * `timingSafeEqual` — no una comparación `===`, que filtra por temporización
 * cuánto del secreto coincidió.
 *
 * Ejecuta `scripts/pipeline-diario.js` como proceso hijo (mismo patrón que
 * `/api/dashboard/casino/sync`: `process.execPath` + argv array, nunca una
 * shell) y ESPERA a que termine antes de responder — nunca "202 accepted"
 * seguido de un spawn que puede fallar después sin que nadie se entere. El
 * script se invoca con `--json`, que además de sus logs humanos habituales
 * imprime una última línea `PIPELINE_RESULT_JSON:{...}` con el resumen real
 * por plataforma (scripts/pipeline-diario.js `runPipeline()`).
 *
 * `ok:true` (HTTP 200) exige AMBAS cosas: el proceso hijo terminó con
 * código de salida 0 Y el resumen parseado dice `ok:true`. Cualquier otra
 * combinación (código != 0, señal/kill → código null, JSON ilegible, o un
 * `ok:true` en el JSON pero código != 0 — una contradicción que igual debe
 * tratarse como fallo, nunca como éxito) es `ok:false`. Un timeout mata el
 * proceso hijo explícitamente y lo reporta como fallo, nunca deja la request
 * colgada indefinidamente ni la resuelve como si nada hubiera pasado.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET no configurado en el servidor' }, { status: 503 })
  }

  const provided = req.headers.get('x-cron-secret') ?? ''
  if (!safeEqual(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'DATABASE_URL no configurado en el servidor' }, { status: 503 })
  }

  const scriptsDir      = path.resolve(process.cwd(), '..', 'scripts')
  const pipelineScript  = path.join(scriptsDir, 'pipeline-diario.js')

  try {
    const { code, stdout, spawnError, timedOut } = await runPipelineChild(pipelineScript)

    if (spawnError) {
      console.error('[/api/cron/casino-sync POST] spawn error:', spawnError)
      return NextResponse.json({ ok: false, error: 'No se pudo iniciar el pipeline' }, { status: 500 })
    }

    if (timedOut) {
      console.error(`[/api/cron/casino-sync POST] pipeline timed out after ${CHILD_TIMEOUT_MS}ms — killed`)
      return NextResponse.json({ ok: false, error: `El pipeline no terminó en ${CHILD_TIMEOUT_MS / 1000}s — proceso terminado` }, { status: 504 })
    }

    const summary = extractJsonResult(stdout)
    // code === 0 AND summary.ok === true are both required. A summary that
    // claims ok:true from a process that exited non-zero (or was killed by a
    // signal, code === null) is a contradiction — never trusted as success.
    const ok = code === 0 && !!summary?.ok

    if (!summary) {
      console.error('[/api/cron/casino-sync POST] pipeline finished without a parseable result (code=' + code + ')')
      return NextResponse.json({ ok: false, error: 'El pipeline terminó sin un resumen interpretable', exitCode: code }, { status: 500 })
    }

    return NextResponse.json({ ...summary, ok }, { status: ok ? 200 : 207 }) // 207: algunas plataformas/pasos fallaron, el resumen real igual viaja
  } catch (e) {
    console.error('[/api/cron/casino-sync POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'Pipeline falló antes de poder producir un resumen' }, { status: 500 })
  }
}

function runPipelineChild(script: string): Promise<{ code: number | null; stdout: string; spawnError: string | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let buffered = ''
    let truncated = false
    let settled = false

    const child = spawn(process.execPath, [script, '--json'], {
      stdio: ['ignore', 'pipe', 'inherit'], // stderr inherited straight to server logs; stdout captured for the JSON marker
      env:   process.env,
    })

    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return
      buffered += d.toString()
      if (buffered.length > STDOUT_BUFFER_LIMIT) {
        // Keep only the tail — the JSON marker line is always LAST, and a
        // runaway historical run's human logs are not worth holding in memory.
        buffered = buffered.slice(-STDOUT_BUFFER_LIMIT)
        truncated = true
      }
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({ code: null, stdout: buffered, spawnError: null, timedOut: true })
    }, CHILD_TIMEOUT_MS)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout: buffered, spawnError: err.message, timedOut: false })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: buffered, spawnError: null, timedOut: false })
    })
  })
}

function extractJsonResult(stdout: string): { ok: boolean; [k: string]: unknown } | null {
  const marker = 'PIPELINE_RESULT_JSON:'
  const line = stdout.split('\n').reverse().find((l) => l.startsWith(marker))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice(marker.length))
    return typeof parsed === 'object' && parsed && typeof parsed.ok === 'boolean' ? parsed : null
  } catch {
    return null
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  // timingSafeEqual throws on mismatched lengths — comparing against a
  // fixed buffer first keeps the check constant-time relative to the
  // secret's length instead of short-circuiting on a length mismatch.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}
