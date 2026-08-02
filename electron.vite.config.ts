import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/** 仅在打包产物里注入 CSP（开发态的 HMR/react-refresh 需要内联脚本，不能加） */
function injectCspOnBuild(): Plugin {
  const csp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
  return {
    name: 'inject-csp-on-build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) return html
        return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
      },
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@engine': resolve(import.meta.dirname, 'src/engine'),
        '@shared': resolve(import.meta.dirname, 'src/shared'),
      },
    },
    plugins: [react(), tailwindcss(), injectCspOnBuild()],
  },
})
