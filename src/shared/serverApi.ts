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

/**
 * 网页访问记录（数据目录 access/YYYY-MM.jsonl 的一行）：
 *   page 已登录打开网页（刷新也算一次）；login-page 没登录、看到登录页；login-ok / login-fail 输密码对 / 错；
 *   export 导出汇总表（取原始 KK 汇总表当底版）
 */
export type AccessKind = 'page' | 'login-page' | 'login-ok' | 'login-fail' | 'export'
/** 从哪进来：cloudflare = 公司域名（Cloudflare 通道）；funnel = ts.net 公网；tailnet = ts.net 内网（自己的设备）；local = 本机 */
export type AccessVia = 'cloudflare' | 'funnel' | 'tailnet' | 'local'

export interface AccessEvent {
  /** 时间（ISO，UTC） */
  t: string
  /** Mac 本地日期 YYYY-MM-DD，按它分天 */
  d: string
  kind: AccessKind
  via: AccessVia
  host: string
  /** 登录身份：密码登录 / Tailscale 登录名 / local；没登录为空 */
  user: string
  /** 访客 IP：Cloudflare 给的 Cf-Connecting-Ip、Tailscale 给的 X-Forwarded-For，本机为 127.0.0.1 */
  ip: string
  /** Cloudflare 给的国家代码 */
  country?: string
  ua: string
  path?: string
}

/** 一天、一个入口的汇总 */
export interface VisitDay {
  date: string
  entry: string
  /** 打开网页次数（已登录） */
  pages: number
  /** 打开网页的不同访客数（按 IP + 浏览器区分，约数） */
  visitors: number
  loginOk: number
  loginFail: number
  /** 看到登录页的次数（含扫网站的机器人） */
  loginPage: number
  exports: number
  users: string[]
}

/** GET /api/visits?days=N[&detail=1] */
export interface VisitsReport {
  /** 有访问的日期 × 入口，新的在前 */
  days: VisitDay[]
  /** 查的每一天（今天在前），没访问的日子也在 */
  dates: string[]
  events?: AccessEvent[]
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
