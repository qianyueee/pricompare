// Mac 上的 pricompare 服务：保存总表、按顺序应用改动、记历史，并把网页版发给浏览器。
// 用法：node server.mjs --data <数据目录> [--port 8790] [--tunnel-port 8791] [--web <dist-web 目录>]
// --tunnel-port：另开一个只给 cloudflared 连的端口（公司域名经 Cloudflare 通道进来），这个端口上一律密码登录
import { randomBytes } from 'node:crypto'
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
    'tunnel-port': { type: 'string', default: process.env.PRICOMPARE_TUNNEL_PORT ?? '' },
    web: { type: 'string' },
  },
})

const dataDir = resolve(values.data ?? process.env.PRICOMPARE_DATA ?? 'pricompare-data')
const port = Number(values.port)
const tunnelPort = values['tunnel-port'] ? Number(values['tunnel-port']) : undefined
if (tunnelPort !== undefined && (!Number.isInteger(tunnelPort) || tunnelPort <= 0 || tunnelPort === port)) {
  throw new Error(`--tunnel-port 不对：${values['tunnel-port']}（要和 --port 不同）`)
}
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

/** 密码登录 cookie 的签名密钥：第一次启动时生成，存在数据目录里，重启后已登录的人不用重输密码 */
function loadSessionKey(): Buffer {
  const path = join(dataDir, 'session.key')
  if (!existsSync(path)) writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex')
  if (key.length < 32) throw new Error(`${path} 内容不对：删掉它重启服务会重新生成（已登录的人要重输密码）`)
  return key
}

const store = new DataStore(dataDir)
await store.open()
if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify(DEFAULT_AUTH, null, 2)}\n`)
loadAuth()

const { handler, close } = createHandler({
  store,
  auth: loadAuth,
  sessionKey: loadSessionKey(),
  staticDir: existsSync(join(webDir, 'index.html')) ? webDir : undefined,
})
const servers = [createServer((req, res) => void handler(req, res, 'direct'))]
servers[0].listen(port, '127.0.0.1', () => {
  console.log(`pricompare 服务已启动：http://127.0.0.1:${port}  数据目录 ${dataDir}  总表版本 ${store.getVersion()}`)
})
if (tunnelPort !== undefined) {
  const tunnel = createServer((req, res) => void handler(req, res, 'tunnel'))
  tunnel.listen(tunnelPort, '127.0.0.1', () => console.log(`Cloudflare 通道入口：http://127.0.0.1:${tunnelPort}（只给 cloudflared 连）`))
  servers.push(tunnel)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    close()
    let open = servers.length
    for (const s of servers) s.close(() => --open === 0 && process.exit(0))
    setTimeout(() => process.exit(0), 3_000).unref()
  })
}
