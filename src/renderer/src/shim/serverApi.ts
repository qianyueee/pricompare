import type { PriApi, StoreKey } from '@shared/ipc'
import {
  CLIENT_HEADER,
  SERVER_STORE_KEYS,
  type ImportMasterRequest,
  type MasterFile,
  type MasterSnapshot,
  type OpsSince,
  type PostOpRequest,
  type PostOpResponse,
  type PriServer,
  type ServerSession,
  type VersionEvent,
} from '@shared/serverApi'
import { browserApi } from './browserApi'

/** 服务返回的错误（409 冲突也走这里，带上响应体） */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', [CLIENT_HEADER]: '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new ServerError(res.status, json?.error ?? `HTTP ${res.status}`, json)
  return json as T
}

const server: PriServer = {
  session: () => call<ServerSession>('GET', '/api/session'),
  getMaster: () => call<MasterSnapshot>('GET', '/api/master'),
  getMasterFile: () => call<MasterFile | null>('GET', '/api/master/file'),
  async postOp(req: PostOpRequest): Promise<PostOpResponse> {
    try {
      return await call<PostOpResponse>('POST', '/api/ops', req)
    } catch (err) {
      // 409 冲突是正常结果，交给调用方刷新
      if (err instanceof ServerError && err.status === 409) return err.body as PostOpResponse
      throw err
    }
  },
  importMaster: (req: ImportMasterRequest) => call<{ version: number }>('POST', '/api/master/import', req),
  opsSince: (version: number) => call<OpsSince>('GET', `/api/ops?since=${version}`),
  subscribe(onVersion: (ev: VersionEvent) => void): () => void {
    const es = new EventSource('/api/events')
    const handle = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as Partial<VersionEvent>
        if (typeof data.version === 'number') {
          onVersion({ version: data.version, opId: data.opId ?? null, user: data.user ?? '' })
        }
      } catch {
        // 忽略格式不对的事件
      }
    }
    es.addEventListener('hello', handle)
    es.addEventListener('version', handle)
    return () => es.close()
  },
}

const isServerKey = (key: StoreKey): key is (typeof SERVER_STORE_KEYS)[number] =>
  (SERVER_STORE_KEYS as readonly string[]).includes(key)

/**
 * 网页版连 Mac 上的服务：供应商注册表、映射模板、设置存在服务上；总表经 server 接口按操作同步；
 * 导出仍在浏览器里生成并下载。lastSession 这类只和本浏览器有关的仍存 localStorage。
 */
export const serverApi: PriApi = {
  isDesktop: false,
  server,
  saveXlsx: (req) => browserApi.saveXlsx(req),
  showInFolder: async () => {},
  async storeGet(key: StoreKey): Promise<unknown> {
    if (isServerKey(key)) return call<unknown>('GET', `/api/store/${key}`)
    if (key === 'master' || key === 'masterFile') return null // 总表走 server 接口
    return browserApi.storeGet(key)
  },
  async storeSet(key: StoreKey, value: unknown): Promise<void> {
    if (isServerKey(key)) {
      await call('PUT', `/api/store/${key}`, value)
      return
    }
    if (key === 'master' || key === 'masterFile') return
    await browserApi.storeSet(key, value)
  },
  getVersion: async () => 'web',
}

/** 页面是不是由 Mac 上的 pricompare 服务发出来的（服务会在 index.html 里加这个标记） */
export function servedByPricompareServer(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('meta[name="pri-server"]')
}
