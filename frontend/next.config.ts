import type { NextConfig } from 'next'
import path from 'path'

const config: NextConfig = {
  // Fijar la raíz del tracing al directorio frontend (evita conflicto con package-lock.json raíz del monorepo)
  outputFileTracingRoot: path.join(__dirname),
  // Paquetes Node.js-only que no deben ser bundleados por webpack/turbopack
  serverExternalPackages: ['bullmq', 'redis', 'pg', 'bcryptjs'],
}

export default config
