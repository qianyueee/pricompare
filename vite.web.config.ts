// renderer 单独作为纯网页运行的配置：容器内开发与 Playwright E2E 用。
// Electron 打包用 electron.vite.config.ts；两边的插件与别名保持一致。
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@engine': resolve(import.meta.dirname, 'src/engine'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  build: { outDir: resolve(import.meta.dirname, 'dist-web'), emptyOutDir: true },
})
