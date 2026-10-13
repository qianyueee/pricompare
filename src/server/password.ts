// 公网入口（Tailscale Funnel）的密码登录：密码只存 scrypt 哈希；登录后发一个签名 cookie，服务重启后仍有效，换密码后全部作废。
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'pri_auth'
export const SESSION_MAX_AGE_S = 30 * 24 * 3600

function scrypt(password: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFC'), salt, len, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

/** 生成存进 config.json 的哈希：scrypt$<盐>$<哈希>（base64） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64')
  if (want.length < 16) return false
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length)
  return timingSafeEqual(want, got)
}

/** 签名里带上当前密码哈希：config.json 换了密码，旧 cookie 全部失效 */
function sign(key: Buffer, passwordHash: string, expires: number): string {
  return createHmac('sha256', key).update(`${expires}|${passwordHash}`).digest('base64url')
}

export function makeSession(key: Buffer, passwordHash: string, now = Date.now()): string {
  const expires = now + SESSION_MAX_AGE_S * 1000
  return `${expires}.${sign(key, passwordHash, expires)}`
}

export function checkSession(token: string, key: Buffer, passwordHash: string, now = Date.now()): boolean {
  const m = /^(\d{1,16})\.([\w-]{43})$/.exec(token)
  if (!m || !passwordHash) return false
  const expires = Number(m[1])
  if (expires <= now) return false
  return timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(key, passwordHash, expires)))
}

export function readCookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`
}

/** 登录页：不依赖网页版构建产物，服务自己出 */
export function loginPage(error = ''): string {
  const msg = error ? `<p class="err">${error.replace(/[<>&"]/g, '')}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>询价比价系统</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2329; }
  form { background: #fff; padding: 32px 28px; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
    width: min(320px, calc(100vw - 32px)); box-sizing: border-box; }
  h1 { font-size: 18px; margin: 0 0 20px; }
  input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px 12px; border: 1px solid #d0d3d9; border-radius: 6px; }
  button { margin-top: 14px; width: 100%; font-size: 16px; padding: 10px; border: 0; border-radius: 6px; background: #3370ff; color: #fff; cursor: pointer; }
  .err { color: #d83931; font-size: 14px; margin: 12px 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #1b1c1f; color: #e8e9eb; }
    form { background: #26272b; box-shadow: none; }
    input { background: #1b1c1f; color: #e8e9eb; border-color: #44464d; }
  }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>询价比价系统</h1>
  <input type="password" name="password" placeholder="密码" autocomplete="current-password" autofocus required />
  <button type="submit">进入</button>
  ${msg}
</form>
</body>
</html>
`
}
