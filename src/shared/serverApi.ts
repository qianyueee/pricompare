// Mac 上的 pricompare 服务与网页版之间的接口约定（网页、服务、命令行三方共用）。
import type { MasterData } from '../engine/master/model'
import type { MasterOp, MergeSummary } from '../engine/master/ops'

/** editor 可改总表；viewer 只能看、比价、导出 */
export type ServerRole = 'editor' | 'viewer'

export interface ServerSession {
  user: string
  role: ServerRole
  version: number
}

export interface MasterSnapshot {
  version: number
  master: MasterData | null
}

export interface MasterFile {
  name: string
  b64: string
}

export interface OpRecord {
  version: number
  opId: string
  op: MasterOp
}

/** GET /api/ops?since=N：内存里还留着这段操作就逐条返回，否则让客户端整表重取 */
export type OpsSince = { version: number; ops: OpRecord[] } | { version: number; reset: true }

export interface PostOpRequest {
  baseVersion: number
  opId: string
  op: MasterOp
}

export type PostOpResponse =
  | { applied: true; version: number; changedCells: number; merge?: MergeSummary }
  | { applied: false; version: number; reason: 'conflict' | 'unchanged' }

export interface ImportMasterRequest {
  master: MasterData
  file: MasterFile
}

export interface HistoryEntry {
  version: number
  at: string
  user: string
  source: string
  opId: string
  summary: string
}

/** SSE /api/events 的 version 事件 */
export interface VersionEvent {
  version: number
  opId: string | null
  user: string
}

/** 服务端可读写的 JSON 键（总表本身只能通过操作改） */
export const SERVER_STORE_KEYS = ['settings', 'vendorRegistry', 'mappingTemplates'] as const
export type ServerStoreKey = (typeof SERVER_STORE_KEYS)[number]

/** 改动类请求必须带的头：跨站页面带不上自定义头，浏览器会先发预检而被拒 */
export const CLIENT_HEADER = 'x-pri-client'

/** 网页版连 Mac 上的服务时可用的接口（桌面版和本地浏览器没有） */
export interface PriServer {
  session(): Promise<ServerSession>
  getMaster(): Promise<MasterSnapshot>
  getMasterFile(): Promise<MasterFile | null>
  postOp(req: PostOpRequest): Promise<PostOpResponse>
  importMaster(req: ImportMasterRequest): Promise<{ version: number }>
  opsSince(version: number): Promise<OpsSince>
  /** 订阅总表版本变化；连上（含断线重连）时也会收到一次当前版本 */
  subscribe(onVersion: (ev: VersionEvent) => void): () => void
}
