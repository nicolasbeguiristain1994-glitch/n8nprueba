import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['bullmq', 'redis', 'pg', 'bcryptjs'],
}

export default config
