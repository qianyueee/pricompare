import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import type { MasterData } from '../engine/master/model'
import type { MasterOp } from '../engine/master/ops'
import {
  CLIENT_HEADER,
  SERVER_STORE_KEYS,
  type ImportMasterRequest,
  type PostOpRequest,
  type ServerSession,
  type ServerStoreKey,
} from '../shared/serverApi'
import { identify, type AuthConfig, type Caller } from './auth'
import type { DataStore } from './store'

export interface HandlerOptions {
  store: DataStore
  auth: () => AuthConfig
  /** 网页版构建产物目录（dist-web）；不给则只提供接口 */
  staticDir?: string
}

/** 总表 JSON 一千多行约 1–2 MB；导入时连原始 xlsm 的 base64 一起上来 */
const MAX_BODY = 64 * 1024 * 1024
const SSE_PING_MS = 25_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, '请求太大')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, '请求不是合法的 JSON')
  }
}

function isMasterData(v: unknown): v is MasterData {
  const m = v as MasterData | null
  return !!m && Array.isArray(m.rows) && m.rows.every((r) => r && Array.isArray(r.cells))
}

const OP_KINDS = new Set(['setCells', 'deleteRows', 'restoreRows', 'merge', 'replace', 'batch'])

function isOp(v: unknown): v is MasterOp {
  const o = v as { kind?: unknown } | null
  return !!o && typeof o.kind === 'string' && OP_KINDS.has(o.kind)
}

/** 网页入口里加一个标记，前端据此改走服务端接口 */
function injectServerMarker(html: string): string {
  return html.replace('</head>', '  <meta name="pri-server" content="1" />\n  </head>')
}

export function createHandler(opts: HandlerOptions) {
  const { store } = opts
  const sseClients = new Set<ServerResponse>()

  store.onVersion((ev) => {
    const msg = `event: version\ndata: ${JSON.stringify(ev)}\n\n`
    for (const res of sseClients) res.write(msg)
  })
  const ping = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n')
  }, SSE_PING_MS)
  ping.unref()

  const requireEditor = (caller: Caller) => {
    if (caller.role !== 'editor') throw new HttpError(403, '只读账号不能修改总表')
  }

  /** 改动类请求：必须带自定义头（跨站页面带不上），且来源页与本站同源 */
  const requireClientHeader = (req: IncomingMessage) => {
    if (req.headers[CLIENT_HEADER] !== '1') throw new HttpError(403, '缺少客户端标记')
    const origin = req.headers.origin
    if (origin && URL.parse(origin)?.host !== req.headers.host) throw new HttpError(403, '来源不符')
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'
    const source = String(req.headers['x-pri-source'] ?? 'web').slice(0, 32)
    if (method !== 'GET') requireClientHeader(req)

    if (path === '/api/session' && method === 'GET') {
      const body: ServerSession = { user: caller.user, role: caller.role, version: store.getVersion() }
      return sendJson(res, 200, body)
    }
    if (path === '/api/master' && method === 'GET') return sendJson(res, 200, store.snapshot())
    if (path === '/api/master/file' && method === 'GET') return sendJson(res, 200, await store.getMasterFile())
    if (path === '/api/ops' && method === 'GET') {
      const since = Number(url.searchParams.get('since'))
      if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'since 参数无效')
      return sendJson(res, 200, store.opsSince(since))
    }
    if (path === '/api/ops' && method === 'POST') {
      requireEditor(caller)
      const body = await readBody<PostOpRequest>(req)
      if (!Number.isInteger(body.baseVersion) || typeof body.opId !== 'string' || !body.opId || !isOp(body.op)) {
        throw new HttpError(400, '操作格式不对')
      }
      if (body.op.kind === 'replace' && !isMasterData(body.op.master)) throw new HttpError(400, '总表格式不对')
      const result = await store.applyOp(body.baseVersion, body.opId, body.op, { user: caller.user, source })
      return sendJson(res, result.applied || result.reason === 'unchanged' ? 200 : 409, result)
    }
    if (path === '/api/master/import' && method === 'POST') {
      requireEditor(caller)
      const body = await readBody<ImportMasterRequest>(req)
      if (!isMasterData(body.master) || typeof body.file?.name !== 'string' || typeof body.file?.b64 !== 'string') {
        throw new HttpError(400, '总表格式不对')
      }
      const version = await store.importMaster(body.master, body.file, { user: caller.user, source }, randomUUID())
      return sendJson(res, 200, { version })
    }
    if (path === '/api/history' && method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500)
      return sendJson(res, 200, await store.history(limit))
    }
    const storeKey = path.match(/^\/api\/store\/([A-Za-z]+)$/)?.[1]
    if (storeKey) {
      if (!(SERVER_STORE_KEYS as readonly string[]).includes(storeKey)) throw new HttpError(404, '没有这个键')
      const key = storeKey as ServerStoreKey
      if (method === 'GET') return sendJson(res, 200, await store.getStore(key))
      if (method === 'PUT') {
        requireEditor(caller)
        await store.setStore(key, await readBody<unknown>(req))
        return sendJson(res, 200, { ok: true })
      }
    }
    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(`event: hello\ndata: ${JSON.stringify({ version: store.getVersion() })}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    throw new HttpError(404, '没有这个接口')
  }

  async function serveStatic(res: ServerResponse, url: URL): Promise<void> {
    const root = opts.staticDir
    if (!root) throw new HttpError(404, '没有网页文件')
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    let file = join(root, rel)
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) && file !== root) throw new HttpError(404, '没有这个文件')
    let info = await stat(file).catch(() => null)
    if (!info || info.isDirectory()) {
      // 单页应用：除静态资源外都回到 index.html
      if (rel.startsWith('assets')) throw new HttpError(404, '没有这个文件')
      file = join(root, 'index.html')
      info = await stat(file).catch(() => null)
      if (!info) throw new HttpError(404, '网页还没构建')
    }
    const ext = extname(file)
    let data: Buffer | string = await readFile(file)
    if (file.endsWith('index.html')) data = injectServerMarker(data.toString('utf8'))
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': rel.startsWith('assets') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(data)
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const caller = identify(req, opts.auth())
      if (!caller) throw new HttpError(403, '没有访问权限')
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname.startsWith('/api/')) await api(req, res, url, caller)
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(res, url)
      else throw new HttpError(405, '不支持的请求')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const message = err instanceof Error ? err.message : String(err)
      if (status === 500) console.error(err)
      if (!res.headersSent) sendJson(res, status, { error: message })
      else res.end()
    }
  }

  const close = () => {
    clearInterval(ping)
    for (const res of sseClients) res.end()
    sseClients.clear()
  }

  return { handler, close }
}
