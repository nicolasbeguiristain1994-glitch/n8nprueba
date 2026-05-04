import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
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
