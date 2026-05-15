// Railpack entry point — launches Next.js on the Railway-assigned PORT
const { spawn } = require('child_process')
const http  = require('http')
const https = require('https')

const port = process.env.PORT || 3000

const next = require.resolve('next/dist/bin/next')
const child = spawn('node', [next, 'start', '-p', String(port)], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', code => process.exit(code ?? 0))

// ── Warmup cron ────────────────────────────────────────────────────────────────
// Calls warmup endpoints on a schedule so n8n is not required.
// POST /api/warmup/process     — every 15 minutes (sends warmup messages)
// POST /api/warmup/daily-reset — once per calendar day (resets counters, advances day)

function callInternal(path) {
  const secret = process.env.WARMUP_PROCESS_SECRET || ''
  const base   = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${port}`

  const isHttps = base.startsWith('https')
  const url     = new URL(path, base)
  const driver  = isHttps ? https : http

  const options = {
    hostname: url.hostname,
    port:     url.port || (isHttps ? 443 : 80),
    path:     url.pathname,
    method:   'POST',
    headers:  {
      'Content-Type': 'application/json',
      'Content-Length': '0',
      ...(secret ? { 'x-warmup-secret': secret } : {}),
    },
  }

  const req = driver.request(options, res => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.warn(`[cron] ${path} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`)
      } else {
        console.log(`[cron] ${path} → OK`)
      }
    })
  })
  req.on('error', e => console.error(`[cron] ${path} error:`, e.message))
  req.end()
}

// Wait 45 s for Next.js to finish booting before first call
setTimeout(() => {
  console.log('[cron] Warmup scheduler started')

  // Process every 15 minutes
  callInternal('/api/warmup/process')
  setInterval(() => callInternal('/api/warmup/process'), 15 * 60 * 1000)

  // Daily reset: check every hour; fire only when calendar day changes
  let lastResetDay = new Date().getUTCDate()
  setInterval(() => {
    const today = new Date().getUTCDate()
    if (today !== lastResetDay) {
      lastResetDay = today
      console.log('[cron] New day detected — running daily-reset')
      callInternal('/api/warmup/daily-reset')
    }
  }, 60 * 60 * 1000)
}, 45_000)
