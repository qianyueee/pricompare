import type { IncomingMessage } from 'node:http'
import type { ServerRole } from '../shared/serverApi'

/**
 * 角色配置（数据目录下 config.json）：
 *   editors / viewers：Cloudflare Access 登录邮箱，或 Tailscale 登录名
 *   localRole：本机直接访问（不经 Cloudflare / Tailscale）时的角色，默认 editor
 *   hosts：对外访问时允许的域名（Cloudflare 的域名、本机的 xxx.ts.net 名）；Tailscale 必须列在这里才放行
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

function byList(cfg: AuthConfig, user: string): Caller | null {
  if (cfg.editors.some((e) => e.toLowerCase() === user)) return { user, role: 'editor' }
  if (cfg.viewers.some((e) => e.toLowerCase() === user)) return { user, role: 'viewer' }
  return null
}

/**
 * 判定来访者。服务只监听 127.0.0.1，外部请求只能经 cloudflared 或 Tailscale 进来：
 * - 带 Access 登录邮箱 → 按名单给角色，不在名单上一律拒绝；
 * - 带 Cloudflare 痕迹却没有登录邮箱（Access 没配好）→ 拒绝；
 * - 经 Tailscale Serve（只在 tailnet 内）：tailscaled 先删掉客户端自带的 Tailscale-* 头，再填上登录名 →
 *   域名在 hosts 里、登录名在名单上才放行；经 Funnel（公网）来的没有登录名 → 拒绝；
 * - 本机直接访问 → localRole（Host 必须是 localhost，挡住 DNS 重绑定）。
 */
export function identify(req: IncomingMessage, cfg: AuthConfig): Caller | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return null
  const host = hostName(req)
  const hosts = cfg.hosts.map((h) => h.toLowerCase())
  const email = header(req, 'cf-access-authenticated-user-email').toLowerCase()
  const viaCloudflare = !!(email || header(req, 'cf-ray') || header(req, 'cf-connecting-ip') || header(req, 'cf-access-jwt-assertion'))
  if (viaCloudflare) {
    if (!email) return null
    if (hosts.length > 0 && !hosts.includes(host)) return null
    return byList(cfg, email)
  }
  const tsLogin = header(req, 'tailscale-user-login').toLowerCase()
  const funnel = header(req, 'tailscale-funnel-request')
  if (tsLogin || funnel || host.endsWith('.ts.net')) {
    if (!tsLogin || funnel || !hosts.includes(host)) return null
    return byList(cfg, tsLogin)
  }
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
