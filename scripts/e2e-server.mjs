// E2E 用：清空一份临时数据目录、写入测试权限名单，再启动打包好的 pricompare 服务
// （主端口 5180；5181 当 Cloudflare 通道端口，Tony 在那儿输密码只读进入）。
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const data = join(root, 'e2e/.tmp/server-data')
rmSync(data, { recursive: true, force: true })
mkdirSync(data, { recursive: true })
// 密码哈希格式同 src/server/password.ts：scrypt$<盐>$<哈希>
const salt = randomBytes(16)
const password = `scrypt$${salt.toString('base64')}$${scryptSync('KVS_e2e', salt, 32).toString('base64')}`
const config = { editors: ['zane@example.com'], viewers: [], localRole: 'editor', hosts: ['127.0.0.1'], password, passwordRole: 'viewer' }
writeFileSync(join(data, 'config.json'), JSON.stringify(config, null, 2))
process.argv.push('--data', data, '--port', '5180', '--tunnel-port', '5181')
await import(pathToFileURL(join(root, 'dist-server/server.mjs')).href)
