// Mac 上的 pricompare 服务：保存总表、按顺序应用改动、记历史，并把网页版发给浏览器。
// 用法：node server.mjs --data <数据目录> [--port 8790] [--web <dist-web 目录>]
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_AUTH, normalizeAuth, type AuthConfig } from './auth'
import { createHandler } from './http'
import { DataStore } from './store'

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    port: { type: 'string', default: process.env.PRICOMPARE_PORT ?? '8790' },
    web: { type: 'string' },
  },
})

const dataDir = resolve(values.data ?? process.env.PRICOMPARE_DATA ?? 'pricompare-data')
const port = Number(values.port)
const here = dirname(fileURLToPath(import.meta.url))
const webDir = resolve(values.web ?? join(here, 'web'))

const configPath = join(dataDir, 'config.json')

/** 每次请求读一次配置的缓存：改 config.json 后几秒内生效，不用重启 */
let auth: AuthConfig = DEFAULT_AUTH
let authLoadedAt = 0
function loadAuth(): AuthConfig {
  if (Date.now() - authLoadedAt < 5_000) return auth
  authLoadedAt = Date.now()
  try {
    auth = normalizeAuth(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch (err) {
    console.error(`读取 ${configPath} 失败，沿用上次的权限配置：`, err)
  }
  return auth
}

const store = new DataStore(dataDir)
await store.open()
if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify(DEFAULT_AUTH, null, 2)}\n`)
loadAuth()

const { handler, close } = createHandler({
  store,
  auth: loadAuth,
  staticDir: existsSync(join(webDir, 'index.html')) ? webDir : undefined,
})
const server = createServer((req, res) => void handler(req, res))
server.listen(port, '127.0.0.1', () => {
  console.log(`pricompare 服务已启动：http://127.0.0.1:${port}  数据目录 ${dataDir}  总表版本 ${store.getVersion()}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3_000).unref()
  })
}
