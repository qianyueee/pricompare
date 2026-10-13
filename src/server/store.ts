import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrateMasterLayout, type MasterData } from '../engine/master/model'
import { applyMasterOp, describeMasterOp, opShiftsRows, type MasterOp } from '../engine/master/ops'
import { migrateVendorRegistry, type Vendor } from '../engine/vendor'
import type {
  HistoryEntry,
  MasterFile,
  MasterSnapshot,
  OpRecord,
  OpsSince,
  PostOpResponse,
  ServerStoreKey,
  VersionEvent,
} from '../shared/serverApi'

/**
 * 服务端数据目录：
 *   master.json          当前总表 + 版本号（每次操作后整份原子写入）
 *   master-file.json     导入时的原始 KK 汇总表（导出时在它上面打补丁）
 *   store/<key>.json     供应商注册表、映射模板、设置
 *   history/YYYY-MM.jsonl 每次操作一行：谁、何时、改了什么、怎么撤销
 *   snapshots/master-YYYYMMDD.json 每天第一次改动前的整表，误操作时可回到当天开头
 */

/** 内存里保留的最近操作条数，供网页端增量追上 */
const OP_LOG_LIMIT = 500
/** 每日快照保留天数 */
const SNAPSHOT_KEEP_DAYS = 60

export interface OpContext {
  user: string
  source: string
}

interface MasterFileJson {
  version: number
  updatedAt: string
  master: MasterData | null
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** 先写临时文件再改名：断电或崩溃时不会留下写了一半的 JSON */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

function localDay(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 历史里不存整张表（replace 的内容在快照里），其余操作原样存 */
function opForHistory(op: MasterOp): unknown {
  if (op.kind === 'replace') return { kind: 'replace', sourceFileName: op.master.sourceFileName, rows: op.master.rows.length }
  if (op.kind === 'batch') return { kind: 'batch', ops: op.ops.map(opForHistory) }
  return op
}

export class DataStore {
  private master: MasterData | null = null
  private version = 0
  private log: OpRecord[] = []
  private appliedIds = new Map<string, number>()
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(ev: VersionEvent) => void>()
  private lastSnapshotDay: string | null = null

  constructor(readonly dir: string) {}

  async open(): Promise<void> {
    await mkdir(join(this.dir, 'store'), { recursive: true })
    await mkdir(join(this.dir, 'history'), { recursive: true })
    await mkdir(join(this.dir, 'snapshots'), { recursive: true })
    const saved = await readJson<MasterFileJson>(join(this.dir, 'master.json'))
    if (saved) {
      this.version = saved.version
      this.master = saved.master ? migrateMasterLayout(saved.master).master : null
    }
    const reg = await readJson<Vendor[]>(this.storePath('vendorRegistry'))
    if (Array.isArray(reg) && reg.length > 0) {
      const m = migrateVendorRegistry(reg)
      if (m.migrated) await writeJsonAtomic(this.storePath('vendorRegistry'), m.registry)
    }
    const snaps = await readdir(join(this.dir, 'snapshots'))
    this.lastSnapshotDay = snaps
      .map((f) => f.match(/^master-(\d{8})(?:-v\d+)?\.json$/)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null
  }

  /** 所有改动排队串行执行，读不排队 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  snapshot(): MasterSnapshot {
    return { version: this.version, master: this.master }
  }

  getVersion(): number {
    return this.version
  }

  opsSince(since: number): OpsSince {
    if (since === this.version) return { version: this.version, ops: [] }
    const first = this.log[0]
    if (since > this.version || !first || first.version > since + 1) return { version: this.version, reset: true }
    return { version: this.version, ops: this.log.filter((r) => r.version > since) }
  }

  onVersion(fn: (ev: VersionEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * 应用一个操作。基于旧版本的操作：期间没有删行/插行时，改格和并入仍按原意落到同一行；
   * 删行、恢复行要求基于最新版本，否则返回 conflict 让网页端刷新后重做。
   */
  applyOp(baseVersion: number, opId: string, op: MasterOp, ctx: OpContext): Promise<PostOpResponse> {
    return this.serial(async () => {
      const done = this.appliedIds.get(opId)
      if (done !== undefined) return { applied: true, version: done, changedCells: 0 }
      if (baseVersion !== this.version) {
        const between = this.opsSince(baseVersion)
        const stale =
          baseVersion > this.version ||
          'reset' in between ||
          opShiftsRows(op) ||
          op.kind === 'replace' ||
          between.ops.some((r) => opShiftsRows(r.op))
        if (stale) return { applied: false, version: this.version, reason: 'conflict' }
      }
      const result = applyMasterOp(this.master ?? emptyMaster(), op)
      if (result.master === this.master || (result.changedCells === 0 && op.kind !== 'replace')) {
        return { applied: false, version: this.version, reason: 'unchanged' }
      }
      await this.commit(result.master, opId, op, ctx, result.inverse)
      return {
        applied: true,
        version: this.version,
        changedCells: result.changedCells,
        ...(result.merge ? { merge: result.merge } : {}),
      }
    })
  }

  /** 整表导入：总表替换 + 保存原始文件（之后导出都在这份原件上打补丁） */
  importMaster(master: MasterData, file: MasterFile, ctx: OpContext, opId: string): Promise<number> {
    return this.serial(async () => {
      await writeJsonAtomic(join(this.dir, 'master-file.json'), file)
      await this.commit(master, opId, { kind: 'replace', master }, ctx, null)
      return this.version
    })
  }

  private async commit(
    next: MasterData,
    opId: string,
    op: MasterOp,
    ctx: OpContext,
    inverse: MasterOp | null,
  ): Promise<void> {
    const now = new Date()
    await this.snapshot_(now, op.kind === 'replace')
    const version = this.version + 1
    await writeJsonAtomic(join(this.dir, 'master.json'), {
      version,
      updatedAt: now.toISOString(),
      master: next,
    } satisfies MasterFileJson)
    this.master = next
    this.version = version
    const entry = {
      version,
      at: now.toISOString(),
      user: ctx.user,
      source: ctx.source,
      opId,
      summary: describeMasterOp(op),
      op: opForHistory(op),
      inverse: inverse ? opForHistory(inverse) : null,
    }
    const month = now.toISOString().slice(0, 7)
    await appendFile(join(this.dir, 'history', `${month}.jsonl`), `${JSON.stringify(entry)}\n`)
    this.log.push({ version, opId, op })
    if (this.log.length > OP_LOG_LIMIT) this.log.splice(0, this.log.length - OP_LOG_LIMIT)
    this.appliedIds.set(opId, version)
    if (this.appliedIds.size > OP_LOG_LIMIT * 2) {
      const oldest = this.appliedIds.keys().next().value
      if (oldest !== undefined) this.appliedIds.delete(oldest)
    }
    const ev: VersionEvent = { version, opId, user: ctx.user }
    for (const fn of this.listeners) fn(ev)
  }

  /** 每天第一次改动前、以及每次整表替换前，把改动前的整表存一份 */
  private async snapshot_(now: Date, beforeReplace: boolean): Promise<void> {
    const day = localDay(now)
    if (!this.master || (this.lastSnapshotDay === day && !beforeReplace)) return
    const name = this.lastSnapshotDay === day ? `master-${day}-v${this.version}.json` : `master-${day}.json`
    await writeJsonAtomic(join(this.dir, 'snapshots', name), { version: this.version, master: this.master })
    this.lastSnapshotDay = day
    await this.pruneSnapshots(now)
  }

  private async pruneSnapshots(now: Date): Promise<void> {
    const cutoff = localDay(new Date(now.getTime() - SNAPSHOT_KEEP_DAYS * 86_400_000))
    for (const f of await readdir(join(this.dir, 'snapshots'))) {
      const d = f.match(/^master-(\d{8})(?:-v\d+)?\.json$/)?.[1]
      if (d && d < cutoff) await rm(join(this.dir, 'snapshots', f), { force: true })
    }
  }

  async history(limit: number): Promise<HistoryEntry[]> {
    const files = (await readdir(join(this.dir, 'history'))).filter((f) => f.endsWith('.jsonl')).sort().reverse()
    const out: HistoryEntry[] = []
    for (const f of files) {
      const lines = (await readFile(join(this.dir, 'history', f), 'utf8')).split('\n').filter(Boolean).reverse()
      for (const line of lines) {
        const e = JSON.parse(line) as HistoryEntry
        out.push({ version: e.version, at: e.at, user: e.user, source: e.source, opId: e.opId, summary: e.summary })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  getMasterFile(): Promise<MasterFile | null> {
    return readJson<MasterFile>(join(this.dir, 'master-file.json'))
  }

  private storePath(key: ServerStoreKey): string {
    return join(this.dir, 'store', `${key}.json`)
  }

  getStore(key: ServerStoreKey): Promise<unknown> {
    return readJson<unknown>(this.storePath(key))
  }

  setStore(key: ServerStoreKey, value: unknown): Promise<void> {
    return this.serial(() => writeJsonAtomic(this.storePath(key), value))
  }
}

function emptyMaster(): MasterData {
  return { rows: [], sheetName: 'KK询价汇总', passthrough: [], sourceFileName: null, importedAt: Date.now() }
}
