// Mac 上的 pricompare 服务与命令行：打成两个不依赖 node_modules 的 .mjs，Node 22 直接运行。
// 网页版用 vite.web.config.ts 构建到 dist-web；部署时拷到 dist-server/web。
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolve(import.meta.dirname, 'src/engine'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true,
    target: 'node22',
    outDir: resolve(import.meta.dirname, 'dist-server'),
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: {
        server: resolve(import.meta.dirname, 'src/server/main.ts'),
        cli: resolve(import.meta.dirname, 'src/server/cli.ts'),
      },
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
    },
  },
})
