import { mkdtemp, readdir, rm, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccessLog, summarize, type AccessInput } from '../../src/server/access'
import { shortUa } from '../../src/server/cliRun'
import type { AccessEvent } from '@shared/serverApi'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pri-access-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const visit = (over: Partial<AccessInput> = {}): AccessInput => ({
  kind: 'page',
  via: 'cloudflare',
  host: 'quote.kvstek.com',
  user: '密码登录',
  ip: '203.0.113.9',
  ua: 'UA1',
  ...over,
})

describe('访问记录', () => {
  it('按本地日期分天；没人访问的日子也在 dates 里；超过保留期的月份文件删掉', async () => {
    let now = new Date(2026, 10, 4, 9, 0)
    const log = new AccessLog(join(dir, 'access'), () => now)
    await mkdir(join(dir, 'access'), { recursive: true })
    await writeFile(join(dir, 'access', '2025-10.jsonl'), '')
    await writeFile(join(dir, 'access', '2025-11.jsonl'), '')
    log.record(visit())
    log.record(visit({ ip: '198.51.100.1' }))
    now = new Date(2026, 10, 6, 23, 59)
    log.record(visit())
    log.record(visit({ via: 'funnel', host: 'mac.tail0000.ts.net', ip: '' }))
    log.record(visit({ kind: 'login-page', user: '', ua: 'zgrab' }))
    await log.flush()
    // 含当月保留 13 个月：2025-11 还在，2025-10 删掉
    expect((await readdir(join(dir, 'access'))).sort()).toEqual(['2025-11.jsonl', '2026-11.jsonl'])
    // 写了一半的行跳过
    await appendFile(join(dir, 'access', '2026-11.jsonl'), '{"t":"2026-11-0')

    const rep = await log.report(3)
    expect(rep.dates).toEqual(['2026-11-06', '2026-11-05', '2026-11-04'])
    expect(rep.days.map((d) => [d.date, d.entry, d.pages, d.visitors, d.loginPage])).toEqual([
      ['2026-11-06', 'quote.kvstek.com', 1, 1, 1],
      ['2026-11-06', 'ts.net 公网', 1, 1, 0],
      ['2026-11-04', 'quote.kvstek.com', 2, 2, 0],
    ])
    expect(rep.events).toBeUndefined()
    // 只查今天
    expect((await log.report(1, true)).events).toHaveLength(3)
  })

  it('汇总：同一 IP + 浏览器算一个访客；登录页和登录失败不计身份', () => {
    const ev = (over: Partial<AccessEvent>): AccessEvent => ({
      t: '2026-11-06T01:00:00.000Z',
      d: '2026-11-06',
      kind: 'page',
      via: 'cloudflare',
      host: 'quote.kvstek.com',
      user: '密码登录',
      ip: '1.1.1.1',
      ua: 'a',
      ...over,
    })
    const days = summarize([
      ev({}),
      ev({}),
      ev({ ua: 'b' }),
      ev({ kind: 'login-fail', user: '' }),
      ev({ kind: 'export' }),
      ev({ via: 'local', host: 'localhost', user: 'local' }),
    ])
    expect(days).toEqual([
      { date: '2026-11-06', entry: 'quote.kvstek.com', pages: 3, visitors: 2, loginOk: 0, loginFail: 1, loginPage: 0, exports: 1, users: ['密码登录'] },
      { date: '2026-11-06', entry: '本机', pages: 1, visitors: 1, loginOk: 0, loginFail: 0, loginPage: 0, exports: 0, users: ['local'] },
    ])
  })

  it('浏览器标识缩写', () => {
    expect(shortUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone Safari')
    expect(shortUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Windows Edge')
    expect(shortUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36')).toBe('Mac Chrome')
    expect(shortUa('curl/8.7.1')).toMatch(/^机器人/)
    expect(shortUa('')).toBe('?')
  })
})
