// 把网页版构建产物（dist-web）拷进 dist-server/web，服务默认从这里发网页。
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const from = resolve(root, 'dist-web')
const to = resolve(root, 'dist-server/web')
if (!existsSync(resolve(from, 'index.html'))) {
  console.error('dist-web 里没有网页，先运行 npm run build:web')
  process.exit(1)
}
rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true })
console.log(`网页已拷到 ${to}`)
