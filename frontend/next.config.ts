import type { NextConfig } from 'next'
import path from 'path'

const config: NextConfig = {
  // Requerido por el Dockerfile de Railway (COPY --from=builder /app/.next/standalone)
  output: 'standalone',
  // Apunta al monorepo root para resolver el conflicto de lockfiles en Railway
  outputFileTracingRoot: path.join(__dirname, '..'),
  // Paquetes Node.js-only que no deben ser bundleados por webpack/turbopack
  serverExternalPackages: ['bullmq', 'redis', 'pg', 'bcryptjs'],
}

export default config
