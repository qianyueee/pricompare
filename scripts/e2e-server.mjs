// E2E 用：清空一份临时数据目录、写入测试权限名单，再启动打包好的 pricompare 服务（端口 5180）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const data = join(root, 'e2e/.tmp/server-data')
rmSync(data, { recursive: true, force: true })
mkdirSync(data, { recursive: true })
const config = { editors: ['zane@example.com'], viewers: ['tony@example.com'], localRole: 'editor', hosts: [] }
writeFileSync(join(data, 'config.json'), JSON.stringify(config, null, 2))
process.argv.push('--data', data, '--port', '5180')
await import(pathToFileURL(join(root, 'dist-server/server.mjs')).href)
