import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'npm run dev:web',
      port: 5173,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // 网页版连 Mac 上的服务：先构建网页和服务，再用临时数据目录启动
      command: 'npm run build:web && npm run build:server && node scripts/e2e-server.mjs',
      url: 'http://127.0.0.1:5180/api/session',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
