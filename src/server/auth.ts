import type { IncomingMessage } from 'node:http'
import type { ServerRole } from '../shared/serverApi'
import { checkSession, readCookie, SESSION_COOKIE } from './password'

/**
 * 角色配置（数据目录下 config.json）：
 *   editors / viewers：Cloudflare Access 登录邮箱，或 Tailscale 登录名
 *   localRole：本机直接访问（不经 Cloudflare / Tailscale）时的角色，默认 editor
 *   hosts：对外访问时允许的域名（Cloudflare 的域名、本机的 xxx.ts.net 名）；Tailscale 必须列在这里才放行
 *   password：经 Tailscale（含 Funnel 公网）进来、又不在名单上的人输的密码，存哈希（node cli.mjs hash-password 生成）；空 = 不开密码登录
 *   passwordRole：密码登录的角色，默认 viewer
 */
export interface AuthConfig {
  editors: string[]
  viewers: string[]
  localRole: ServerRole
  hosts: string[]
  password: string
  passwordRole: ServerRole
}

export const DEFAULT_AUTH: AuthConfig = {
  editors: [],
  viewers: [],
  localRole: 'editor',
  hosts: [],
  password: '',
  passwordRole: 'viewer',
}

/** 密码登录的人在历史记录里的名字 */
export const PASSWORD_USER = '密码登录'

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

/** 经 cloudflared 进来的请求（带 Access 邮箱或 Cloudflare 自己加的头） */
function viaCloudflare(req: IncomingMessage): boolean {
  return !!(
    header(req, 'cf-access-authenticated-user-email') ||
    header(req, 'cf-ray') ||
    header(req, 'cf-connecting-ip') ||
    header(req, 'cf-access-jwt-assertion')
  )
}

/** 经 Tailscale Serve / Funnel 进来的请求 */
function viaTailscale(req: IncomingMessage): boolean {
  return !!(header(req, 'tailscale-user-login') || header(req, 'tailscale-funnel-request') || hostName(req).endsWith('.ts.net'))
}

const hostListed = (req: IncomingMessage, cfg: AuthConfig) => cfg.hosts.some((h) => h.toLowerCase() === hostName(req))

/** 这个请求可以用密码登录：经 Tailscale（含 Funnel）进来、域名在 hosts 里，且配了密码 */
export function passwordGate(req: IncomingMessage, cfg: AuthConfig): boolean {
  return (
    LOOPBACK.has(req.socket.remoteAddress ?? '') &&
    !!cfg.password &&
    !viaCloudflare(req) &&
    viaTailscale(req) &&
    hostListed(req, cfg)
  )
}

/**
 * 判定来访者。服务只监听 127.0.0.1，外部请求只能经 cloudflared 或 Tailscale 进来：
 * - 带 Access 登录邮箱 → 按名单给角色，不在名单上一律拒绝；
 * - 带 Cloudflare 痕迹却没有登录邮箱（Access 没配好）→ 拒绝；
 * - 经 Tailscale（域名必须在 hosts 里）：
 *   - Serve（只在 tailnet 内）：tailscaled 先删掉客户端自带的 Tailscale-* 头，再填上登录名 → 登录名在名单上就按名单给角色；
 *   - Funnel（公网）来的没有登录名，名单外的 tailnet 成员也一样 → 带有效的密码 cookie 才放行（角色 passwordRole），否则拒绝；
 * - 本机直接访问 → localRole（Host 必须是 localhost，挡住 DNS 重绑定）。
 */
export function identify(req: IncomingMessage, cfg: AuthConfig, sessionKey?: Buffer): Caller | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return null
  const host = hostName(req)
  if (viaCloudflare(req)) {
    const email = header(req, 'cf-access-authenticated-user-email').toLowerCase()
    if (!email) return null
    if (cfg.hosts.length > 0 && !hostListed(req, cfg)) return null
    return byList(cfg, email)
  }
  if (viaTailscale(req)) {
    if (!hostListed(req, cfg)) return null
    const tsLogin = header(req, 'tailscale-user-login').toLowerCase()
    const listed = tsLogin && !header(req, 'tailscale-funnel-request') ? byList(cfg, tsLogin) : null
    if (listed) return listed
    const token = readCookie(req, SESSION_COOKIE)
    if (sessionKey && token && checkSession(token, sessionKey, cfg.password)) return { user: PASSWORD_USER, role: cfg.passwordRole }
    return null
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
    password: typeof o.password === 'string' ? o.password : '',
    passwordRole: o.passwordRole === 'editor' ? 'editor' : 'viewer',
  }
}
