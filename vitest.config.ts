import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolve(import.meta.dirname, 'src/engine'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
})
