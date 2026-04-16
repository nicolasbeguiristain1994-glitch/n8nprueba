// Railpack entry point — launches Next.js on the Railway-assigned PORT
const { spawn } = require('child_process')
const port = process.env.PORT || 3000

const next = require.resolve('next/dist/bin/next')
const child = spawn('node', [next, 'start', '-p', String(port)], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', code => process.exit(code ?? 0))
