import { configDefaults, defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    // Shared CI runners cannot sustain four DOM-heavy workers without starving
    // the full-page interaction tests. Keep their assertions and timeouts intact.
    maxWorkers: process.env.CI ? 2 : 4,
    exclude: [...configDefaults.exclude, '**/.next/**'],
    // happy-dom para tests de componentes React (más rápido que jsdom)
    environment: 'happy-dom',
    // Importar matchers de @testing-library/jest-dom en todos los tests
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
