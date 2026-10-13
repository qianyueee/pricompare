import type { IncomingMessage } from 'node:http'
import type { ServerRole } from '../shared/serverApi'

/**
 * 角色配置（数据目录下 config.json）：
 *   editors / viewers：Cloudflare Access 登录邮箱
 *   localRole：本机直接访问（不经 Cloudflare）时的角色，默认 editor
 *   hosts：经 Cloudflare 访问时允许的域名；为空表示不对外
 */
export interface AuthConfig {
  editors: string[]
  viewers: string[]
  localRole: ServerRole
  hosts: string[]
}

export const DEFAULT_AUTH: AuthConfig = { editors: [], viewers: [], localRole: 'editor', hosts: [] }

export interface Caller {
  user: string
  role: ServerRole
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
}

function hostName(req: IncomingMessage): string {
  return header(req, 'host').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * 判定来访者。服务只监听 127.0.0.1，外部请求只能经 cloudflared 进来：
 * - 带 Access 登录邮箱 → 按名单给角色，不在名单上一律拒绝；
 * - 带 Cloudflare 痕迹却没有登录邮箱（Access 没配好）→ 拒绝；
 * - 本机直接访问 → localRole（Host 必须是 localhost，挡住 DNS 重绑定）。
 */
export function identify(req: IncomingMessage, cfg: AuthConfig): Caller | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return null
  const email = header(req, 'cf-access-authenticated-user-email').toLowerCase()
  const viaCloudflare = !!(email || header(req, 'cf-ray') || header(req, 'cf-connecting-ip') || header(req, 'cf-access-jwt-assertion'))
  if (viaCloudflare) {
    if (!email) return null
    if (cfg.hosts.length > 0 && !cfg.hosts.map((h) => h.toLowerCase()).includes(hostName(req))) return null
    if (cfg.editors.some((e) => e.toLowerCase() === email)) return { user: email, role: 'editor' }
    if (cfg.viewers.some((e) => e.toLowerCase() === email)) return { user: email, role: 'viewer' }
    return null
  }
  const host = hostName(req)
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return null
  return { user: 'local', role: cfg.localRole }
}

export function normalizeAuth(raw: unknown): AuthConfig {
  const o = (raw ?? {}) as Partial<Record<keyof AuthConfig, unknown>>
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    editors: list(o.editors),
    viewers: list(o.viewers),
    localRole: o.localRole === 'viewer' ? 'viewer' : 'editor',
    hosts: list(o.hosts),
  }
}
