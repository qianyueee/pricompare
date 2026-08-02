import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run dev:web',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
