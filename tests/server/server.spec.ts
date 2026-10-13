import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KK_COL_COUNT, type MasterCell, type MasterData, type MasterOp } from '@engine/index'
import { DEFAULT_AUTH, type AuthConfig } from '../../src/server/auth'
import { createHandler } from '../../src/server/http'
import { hashPassword } from '../../src/server/password'
import { DataStore } from '../../src/server/store'
import type { OpsSince, PostOpResponse, VersionEvent } from '@shared/serverApi'
import { makeQuote } from '../fixtures/rows'

function row(vals: Record<number, MasterCell>) {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}

const seedMaster = (): MasterData => ({
  rows: [row({ 0: 1, 1: '20261001 A', 3: 'P-1', 6: 10, 9: 100 }), row({ 0: 2, 1: '20261001 A', 3: 'P-2', 6: 5 })],
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: 'KK询价汇总表20261012.xlsm',
  importedAt: 1,
})

let dir: string
let store: DataStore
let server: Server
let port: number
let auth: AuthConfig
let closeHandler: () => void

async function start() {
  store = new DataStore(join(dir, 'data'))
  await store.open()
  const web = join(dir, 'web')
  await mkdir(join(web, 'assets'), { recursive: true })
  await writeFile(join(web, 'index.html'), '<html><head><title>t</title></head><body></body></html>')
  await writeFile(join(web, 'assets', 'a.js'), 'console.log(1)')
  const h = createHandler({ store, auth: () => auth, staticDir: web })
  closeHandler = h.close
  server = createServer((req, res) => void h.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
}

async function stop() {
  closeHandler()
  await new Promise<void>((r) => server.close(() => r()))
}

interface Res {
  status: number
  body: unknown
  text: string
  headers: IncomingHttpHeaders
}

/** body 是字符串时原样发（登录表单），否则按 JSON 发 */
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          ...(method === 'GET' ? {} : { 'x-pri-client': '1' }),
          ...headers,
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (text += c))
        res.on('end', () => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const postOp = (baseVersion: number, op: MasterOp, opId = Math.random().toString(36).slice(2), headers = {}) =>
  call('POST', '/api/ops', { baseVersion, opId, op }, headers)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pri-server-'))
  auth = { ...DEFAULT_AUTH, editors: ['zane@example.com'], viewers: ['tony@example.com'] }
  await start()
  const r = await call('POST', '/api/master/import', { master: seedMaster(), file: { name: 'kk.xlsm', b64: 'AAAA' } })
  expect(r.status).toBe(200)
})

afterEach(async () => {
  await stop()
  await rm(dir, { recursive: true, force: true })
})

describe('pricompare 服务', () => {
  it('导入后可读总表和原件，版本号 1', async () => {
    const m = await call('GET', '/api/master')
    expect(m.body).toMatchObject({ version: 1, master: { sourceFileName: 'KK询价汇总表20261012.xlsm' } })
    const f = await call('GET', '/api/master/file')
    expect(f.body).toEqual({ name: 'kk.xlsm', b64: 'AAAA' })
  })

  it('改格：版本 +1，写进 master.json 和历史，重启后还在', async () => {
    const r = await postOp(1, { kind: 'setCells', cells: [{ row: 1, col: 10, value: 88 }] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ applied: true, version: 2, changedCells: 1 })
    const saved = JSON.parse(await readFile(join(dir, 'data', 'master.json'), 'utf8'))
    expect(saved.version).toBe(2)
    expect(saved.master.rows[1].cells[10]).toBe(88)
    const hist = await call('GET', '/api/history?limit=5')
    expect((hist.body as { summary: string }[]).map((h) => h.summary)).toEqual(['改 1 格', '整表更新：KK询价汇总表20261012.xlsm'])
    await stop()
    await start()
    const m = await call('GET', '/api/master')
    expect(m.body).toMatchObject({ version: 2 })
    expect((m.body as { master: MasterData }).master.rows[1]!.cells[10]).toBe(88)
  })

  it('同一个 opId 重发不会应用两次', async () => {
    const op: MasterOp = { kind: 'setCells', cells: [{ row: 0, col: 9, value: 101 }] }
    const a = await postOp(1, op, 'same-id')
    const b = await postOp(1, op, 'same-id')
    expect((a.body as PostOpResponse).version).toBe(2)
    expect((b.body as PostOpResponse).version).toBe(2)
    expect(store.getVersion()).toBe(2)
  })

  it('后台并入和网页改格交错：改格基于旧版本仍落到同一行', async () => {
    // 后台（命令行）先并入 CL 的报价
    const merge: MasterOp = {
      kind: 'merge',
      quotes: [makeQuote('P-2', { rev: '', qty: 5, amount: 66 })],
      options: { batch: '20261001 A', vendorSlot: 11, vendorId: 'cl', vendorDisplay: 'CL' },
    }
    const m = await postOp(1, merge, 'merge-1', { 'x-pri-source': 'cli' })
    expect(m.body).toMatchObject({ applied: true, version: 2, merge: { fill: 1 } })
    // 网页端还停在版本 1，改 P-1 的 HC 价
    const e = await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 95 }] })
    expect(e.body).toMatchObject({ applied: true, version: 3 })
    const snap = store.snapshot()
    expect(snap.master!.rows[0]!.cells[9]).toBe(95)
    expect(snap.master!.rows[1]!.cells[11]).toBe(66)
    // 增量追上：版本 1 之后的两步
    const since = (await call('GET', '/api/ops?since=1')).body as OpsSince
    expect('ops' in since && since.ops.map((o) => o.opId)).toEqual(['merge-1', expect.any(String)])
  })

  it('删行要求基于最新版本，否则 409 让网页刷新', async () => {
    await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 95 }] })
    const stale = await postOp(1, { kind: 'deleteRows', rows: [0] })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ applied: false, reason: 'conflict', version: 2 })
    const ok = await postOp(2, { kind: 'deleteRows', rows: [0] })
    expect(ok.body).toMatchObject({ applied: true, version: 3 })
    // 删行之后，基于旧版本的改格也会被挡住（行号已经变了）
    const afterShift = await postOp(2, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 1 }] })
    expect(afterShift.status).toBe(409)
  })

  it('没有改动的操作不加版本', async () => {
    const r = await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 100 }] })
    expect(r.body).toMatchObject({ applied: false, reason: 'unchanged', version: 1 })
  })

  it('经 Cloudflare：Tony 只读，Zane 可改，名单外和没登录的拒绝', async () => {
    const tony = { 'cf-access-authenticated-user-email': 'tony@example.com', 'cf-ray': 'x' }
    const s = await call('GET', '/api/session', undefined, tony)
    expect(s.body).toMatchObject({ user: 'tony@example.com', role: 'viewer' })
    expect((await call('GET', '/api/master', undefined, tony)).status).toBe(200)
    const denied = await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 1 }] }, 'x', tony)
    expect(denied.status).toBe(403)
    const zane = { 'cf-access-authenticated-user-email': 'Zane@example.com', 'cf-ray': 'x' }
    const ok = await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 1 }] }, 'y', zane)
    expect(ok.status).toBe(200)
    const stranger = { 'cf-access-authenticated-user-email': 'who@example.com', 'cf-ray': 'x' }
    expect((await call('GET', '/api/master', undefined, stranger)).status).toBe(403)
    expect((await call('GET', '/', undefined, { 'cf-ray': 'x' })).status).toBe(403)
  })

  it('经 Tailscale Serve：域名列在 hosts、登录名在名单上才放行；Funnel 公网请求拒绝', async () => {
    const ts = 'mac.tail0000.ts.net'
    const zane = { host: `${ts}:8443`, 'tailscale-user-login': 'Zane@example.com', origin: `https://${ts}:8443` }
    // 域名还没列进 hosts：一律拒绝
    expect((await call('GET', '/api/session', undefined, zane)).status).toBe(403)
    auth = { ...auth, hosts: [ts] }
    expect((await call('GET', '/api/session', undefined, zane)).body).toMatchObject({ user: 'zane@example.com', role: 'editor' })
    const ok = await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 7 }] }, 'ts1', zane)
    expect(ok.status).toBe(200)
    const tony = { host: ts, 'tailscale-user-login': 'tony@example.com' }
    expect((await call('GET', '/api/session', undefined, tony)).body).toMatchObject({ role: 'viewer' })
    expect((await postOp(2, { kind: 'deleteRows', rows: [0] }, 'ts2', tony)).status).toBe(403)
    // 名单外的 tailnet 成员、Funnel 公网请求、没有登录名的请求
    expect((await call('GET', '/api/master', undefined, { host: ts, 'tailscale-user-login': 'who@example.com' })).status).toBe(403)
    expect((await call('GET', '/api/master', undefined, { ...zane, 'tailscale-funnel-request': '?1' })).status).toBe(403)
    expect((await call('GET', '/', undefined, { host: ts })).status).toBe(403)
    expect(store.getVersion()).toBe(2)
  })

  it('经 Funnel 公网：配了密码才出登录页；输对拿到只读 cookie；换密码后旧 cookie 失效；错太多次先挡住', async () => {
    const ts = 'mac.tail0000.ts.net'
    const pub = { host: `${ts}:8443`, 'tailscale-funnel-request': '?1' }
    const login = (password: string) =>
      call('POST', '/login', `password=${encodeURIComponent(password)}`, {
        ...pub,
        'content-type': 'application/x-www-form-urlencoded',
        'x-pri-client': '',
      })
    auth = { ...auth, hosts: [ts] }
    // 没配密码：和以前一样拒绝
    expect((await call('GET', '/', undefined, pub)).status).toBe(403)
    expect((await login('KVS_test1')).status).toBe(403)

    auth = { ...auth, password: await hashPassword('KVS_test1') }
    const page = await call('GET', '/', undefined, pub)
    expect(page.status).toBe(200)
    expect(page.text).toContain('action="/login"')
    expect((await call('GET', '/api/master', undefined, pub)).status).toBe(401)
    // Funnel 请求自带登录名也不认
    expect((await call('GET', '/api/master', undefined, { ...pub, 'tailscale-user-login': 'zane@example.com' })).status).toBe(401)
    // 域名不在 hosts 里：没有登录页
    expect((await call('GET', '/', undefined, { ...pub, host: 'other.tail0000.ts.net' })).status).toBe(403)

    expect((await login('wrong')).status).toBe(401)
    const ok = await login('KVS_test1')
    expect(ok.status).toBe(303)
    const setCookie = String(ok.headers['set-cookie'])
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/)
    const cookie = setCookie.split(';')[0]!
    const me = { ...pub, cookie, origin: `https://${ts}:8443` }
    expect((await call('GET', '/api/session', undefined, me)).body).toMatchObject({ user: '密码登录', role: 'viewer' })
    expect((await call('GET', '/api/master', undefined, me)).status).toBe(200)
    expect((await call('GET', '/login', undefined, me)).status).toBe(303)
    expect((await postOp(1, { kind: 'deleteRows', rows: [0] }, 'pw1', me)).status).toBe(403)
    // 改过签名的 cookie、别的域名带 cookie 都不认
    const forged = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    expect((await call('GET', '/api/master', undefined, { ...pub, cookie: forged })).status).toBe(401)
    expect((await call('GET', '/api/master', undefined, { ...me, host: 'other.tail0000.ts.net' })).status).toBe(403)
    // tailnet 里名单上的人照旧按名单（编辑）
    const zane = { host: ts, 'tailscale-user-login': 'zane@example.com' }
    expect((await call('GET', '/api/session', undefined, zane)).body).toMatchObject({ role: 'editor' })

    auth = { ...auth, password: await hashPassword('KVS_test2') }
    expect((await call('GET', '/api/master', undefined, me)).status).toBe(401)
    // 前面错了 1 次，再错 9 次凑满 10 次：之后密码对了也先挡住
    for (let i = 0; i < 9; i++) expect((await login(`x${i}`)).status).toBe(401)
    const locked = await login('KVS_test2')
    expect(locked.status).toBe(429)
    expect(locked.headers['set-cookie']).toBeUndefined()
    expect(store.getVersion()).toBe(1)
  })

  it('本机访问：Host 不是 localhost 拒绝（防 DNS 重绑定）；改动必须带客户端标记', async () => {
    expect((await call('GET', '/api/master', undefined, { host: 'evil.example' })).status).toBe(403)
    const noHeader = await call('POST', '/api/ops', { baseVersion: 1, opId: 'z', op: { kind: 'deleteRows', rows: [0] } }, {
      'x-pri-client': '',
    })
    expect(noHeader.status).toBe(403)
    const crossSite = await postOp(1, { kind: 'deleteRows', rows: [0] }, 'c', { origin: 'https://evil.example' })
    expect(crossSite.status).toBe(403)
    expect(store.getVersion()).toBe(1)
  })

  it('供应商注册表等设置可读写，未知键 404', async () => {
    expect((await call('PUT', '/api/store/vendorRegistry', [{ id: 'cl', display: 'CL', aliases: [] }])).status).toBe(200)
    expect((await call('GET', '/api/store/vendorRegistry')).body).toEqual([{ id: 'cl', display: 'CL', aliases: [] }])
    expect((await call('GET', '/api/store/master')).status).toBe(404)
  })

  it('网页：index.html 带服务端标记，资源可取，路径穿越被挡', async () => {
    const html = await call('GET', '/')
    expect(html.text).toContain('<meta name="pri-server" content="1" />')
    expect((await call('GET', '/some/page')).text).toContain('pri-server')
    expect((await call('GET', '/assets/a.js')).text).toBe('console.log(1)')
    expect((await call('GET', '/assets/missing.js')).status).toBe(404)
    expect((await call('GET', '/../data/master.json')).text).not.toContain('"rows"')
    expect((await call('GET', '/%2e%2e/data/master.json')).text).not.toContain('"rows"')
    expect((await call('GET', '/..%2fdata%2fmaster.json')).text).not.toContain('"rows"')
  })

  it('每天第一次改动前、整表替换前各存一份整表快照', async () => {
    await postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 2 }] })
    await postOp(2, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 3 }] })
    let snaps = (await readdir(join(dir, 'data', 'snapshots'))).sort()
    expect(snaps).toHaveLength(1)
    const snap = JSON.parse(await readFile(join(dir, 'data', 'snapshots', snaps[0]!), 'utf8'))
    expect(snap.version).toBe(1)
    expect(snap.master.rows[0].cells[9]).toBe(100)
    await call('POST', '/api/master/import', { master: seedMaster(), file: { name: 'kk2.xlsm', b64: 'BBBB' } })
    snaps = (await readdir(join(dir, 'data', 'snapshots'))).sort()
    expect(snaps).toHaveLength(2)
    expect(snaps.filter((f) => /-v3\.json$/.test(f))).toHaveLength(1)
  })

  it('改动通过 SSE 推给已打开的网页', async () => {
    const events: VersionEvent[] = []
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        res.setEncoding('utf8')
        let buf = ''
        res.on('data', (c: string) => {
          buf += c
          for (const m of buf.matchAll(/event: version\ndata: (.+)\n\n/g)) events.push(JSON.parse(m[1]!))
          if (events.length > 0) {
            req.destroy()
            resolve()
          }
          if (buf.includes('event: hello')) {
            buf = buf.replace(/event: hello\ndata: .+\n\n/, '')
            void postOp(1, { kind: 'setCells', cells: [{ row: 0, col: 9, value: 3 }] }, 'sse-op')
          }
        })
      })
      req.on('error', reject)
      req.end()
    })
    expect(events[0]).toEqual({ version: 2, opId: 'sse-op', user: 'local' })
  })
})
