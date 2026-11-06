// 网页访问记录：只记「打开网页、看到登录页、登录、导出汇总表」这几件事，不记每个请求（资源、接口、实时推送不算）。
// 按月存在数据目录的 access/YYYY-MM.jsonl，一行一次；visits 命令和 GET /api/visits 按天、按入口汇总。
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccessEvent, AccessKind, AccessVia, VisitDay, VisitsReport } from '../shared/serverApi'

/** 访问记录保留的月数（含当月） */
const KEEP_MONTHS = 13
/** 一次最多查多少天 */
export const MAX_VISIT_DAYS = 400

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 汇总表里的入口名：Cloudflare 通道写域名，其余按怎么进来的写 */
export function entryLabel(e: Pick<AccessEvent, 'via' | 'host'>): string {
  if (e.via === 'cloudflare') return e.host || 'Cloudflare'
  if (e.via === 'funnel') return 'ts.net 公网'
  if (e.via === 'tailnet') return 'ts.net 内网'
  return '本机'
}

export interface AccessInput {
  kind: AccessKind
  via: AccessVia
  host: string
  user: string
  ip: string
  country?: string
  ua: string
  path?: string
}

export class AccessLog {
  private queue: Promise<unknown> = Promise.resolve()
  private ready: Promise<void> | null = null
  private lastMonth = ''

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 记一次访问：排队追加，不等写完、写失败也不影响请求本身 */
  record(input: AccessInput): void {
    const at = this.now()
    const ev: AccessEvent = {
      t: at.toISOString(),
      d: localDate(at),
      kind: input.kind,
      via: input.via,
      host: input.host.slice(0, 100),
      user: input.user.slice(0, 100),
      ip: input.ip.slice(0, 64),
      ...(input.country ? { country: input.country.slice(0, 8) } : {}),
      ua: input.ua.slice(0, 200),
      ...(input.path ? { path: input.path.slice(0, 100) } : {}),
    }
    const month = ev.d.slice(0, 7)
    this.queue = this.queue
      .then(async () => {
        this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined)
        await this.ready
        await appendFile(join(this.dir, `${month}.jsonl`), `${JSON.stringify(ev)}\n`)
        if (month !== this.lastMonth) {
          this.lastMonth = month
          await this.prune(month)
        }
      })
      .catch((err: unknown) => console.error('写访问记录失败：', err))
  }

  /** 等排队的记录写完（测试和关服务时用） */
  flush(): Promise<void> {
    return this.queue.then(() => undefined)
  }

  private async prune(month: string): Promise<void> {
    const [y, m] = month.split('-').map(Number)
    const cut = new Date(y!, m! - KEEP_MONTHS, 1)
    const cutoff = `${cut.getFullYear()}-${String(cut.getMonth() + 1).padStart(2, '0')}`
    for (const f of await readdir(this.dir)) {
      const fm = f.match(/^(\d{4}-\d{2})\.jsonl$/)?.[1]
      if (fm && fm < cutoff) await rm(join(this.dir, f), { force: true })
    }
  }

  /** 最近 days 天（含今天）的记录，按时间先后 */
  async events(days: number): Promise<AccessEvent[]> {
    await this.flush()
    const from = localDate(new Date(this.now().getTime() - (days - 1) * 86_400_000))
    const files = await readdir(this.dir).catch(() => [] as string[])
    const out: AccessEvent[] = []
    for (const f of files.filter((x) => /^\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
      if (f.slice(0, 7) < from.slice(0, 7)) continue
      for (const line of (await readFile(join(this.dir, f), 'utf8')).split('\n')) {
        if (!line) continue
        try {
          const ev = JSON.parse(line) as AccessEvent
          if (ev.d >= from) out.push(ev)
        } catch {
          // 写了一半的行（断电）跳过
        }
      }
    }
    return out
  }

  async report(days: number, detail = false): Promise<VisitsReport> {
    const n = Math.min(Math.max(Math.trunc(days) || 1, 1), MAX_VISIT_DAYS)
    const events = await this.events(n)
    const today = this.now()
    const dates = Array.from({ length: n }, (_, i) => localDate(new Date(today.getTime() - i * 86_400_000)))
    return { days: summarize(events), dates, ...(detail ? { events } : {}) }
  }
}

/** 按天、按入口汇总；新的日期在前，同一天按打开次数多的在前 */
export function summarize(events: AccessEvent[]): VisitDay[] {
  const groups = new Map<string, { day: VisitDay; visitors: Set<string>; users: Set<string> }>()
  for (const ev of events) {
    const entry = entryLabel(ev)
    const key = `${ev.d}\u0000${entry}`
    let g = groups.get(key)
    if (!g) {
      g = {
        day: { date: ev.d, entry, pages: 0, visitors: 0, loginOk: 0, loginFail: 0, loginPage: 0, exports: 0, users: [] },
        visitors: new Set(),
        users: new Set(),
      }
      groups.set(key, g)
    }
    const d = g.day
    if (ev.kind === 'page') {
      d.pages++
      g.visitors.add(`${ev.ip}|${ev.ua}`)
    } else if (ev.kind === 'login-ok') d.loginOk++
    else if (ev.kind === 'login-fail') d.loginFail++
    else if (ev.kind === 'login-page') d.loginPage++
    else if (ev.kind === 'export') d.exports++
    if (ev.user && ev.kind !== 'login-page' && ev.kind !== 'login-fail') g.users.add(ev.user)
  }
  return [...groups.values()]
    .map((g) => ({ ...g.day, visitors: g.visitors.size, users: [...g.users].sort() }))
    .sort((a, b) => (a.date === b.date ? b.pages - a.pages || a.entry.localeCompare(b.entry) : a.date < b.date ? 1 : -1))
}
