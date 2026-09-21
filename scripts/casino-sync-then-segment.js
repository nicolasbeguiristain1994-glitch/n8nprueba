#!/usr/bin/env node
'use strict'

/**
 * Supervisa sync-casino-players-live.js → segmentar-casino-players.js como UN
 * único proceso, detached del que lo lanzó.
 *
 * Por qué existe: frontend/app/api/dashboard/casino/sync/route.ts (botón manual
 * de sync) necesita encadenar sync → segmentación sin bloquear la respuesta
 * HTTP. Encadenarlos con un `child.on('exit', ...)` desde la propia ruta de
 * Next.js depende de que el proceso de Next siga vivo cuando el hijo termine
 * (minutos después) — válido mientras el servidor no se reinicie/redepliegue en
 * el medio, pero no es una garantía real de "corre pase lo que pase". Este
 * wrapper es el que queda detached: la ruta solo lo lanza a ÉL (un proceso
 * corto, sin más trabajo que supervisar), y la cadena sync→segmentar vive
 * dentro de este proceso, no depende de Next.
 *
 * Uso:
 *   node casino-sync-then-segment.js -- --platform=zeus --auto
 *   (todo lo que va después de "--" se pasa tal cual a sync-casino-players-live.js)
 *
 * Un fallo de sync NUNCA debe salir con exit code 0 (ver cabecera del plan /
 * migración 123): si sync-casino-players-live.js falla, este wrapper también
 * sale con código != 0 y NO corre la segmentación.
 */

const { spawn } = require('child_process')
const path      = require('path')

const sepIndex = process.argv.indexOf('--')
const syncArgs = sepIndex === -1 ? [] : process.argv.slice(sepIndex + 1)

const syncScript = path.join(__dirname, 'sync-casino-players-live.js')
const segScript  = path.join(__dirname, 'segmentar-casino-players.js')

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' })
    child.on('error', (err) => {
      console.error(`[casino-sync-then-segment] no se pudo iniciar ${path.basename(script)}: ${err.message}`)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

async function main() {
  const syncCode = await run(syncScript, syncArgs)
  if (syncCode !== 0) {
    console.error(`[casino-sync-then-segment] sync-casino-players-live.js salió con código ${syncCode} — segmentación NO se ejecuta`)
    process.exit(syncCode)
  }

  const segCode = await run(segScript, [])
  process.exit(segCode)
}

main()
