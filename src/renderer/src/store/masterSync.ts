import { applyMasterOp, opShiftsRows, type MasterData, type MasterOp } from '@engine/index'
import type { ImportMasterRequest, PriServer } from '@shared/serverApi'

/** 网页版和 Mac 上的服务之间同步总表时，需要从会话状态里读写的几样东西 */
export interface SyncHost {
  getMaster(): MasterData | null
  /** 本页总表对应的服务端版本 */
  getVersion(): number
  setVersion(version: number): void
  /** 别处（后台每小时并入、另一个窗口）的改动已逐条应用到本页；shifted = 其中有删行/插行 */
  applyRemote(master: MasterData, version: number, shifted: boolean): void
  /** 整表从服务器重取 */
  replaceFromServer(master: MasterData | null, version: number): void
  notify(message: string): void
}

function newOpId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function emptyMaster(): MasterData {
  return { rows: [], sheetName: 'KK询价汇总', passthrough: [], sourceFileName: null, importedAt: Date.now() }
}

/**
 * 本页的改动先在本地立即生效，再按顺序发给服务；所有收发排成一队，不会交错。
 * - 服务确认的版本正好是下一版：本页与服务一致；
 * - 中间夹了别处的改动、或服务拒绝（冲突）：队列空下来后整表重取；
 * - 收到别处改动的通知：队列空闲时取回这几步逐条应用，取不到（服务重启过）就整表重取。
 */
export function createMasterSync(server: PriServer, host: SyncHost) {
  let chain: Promise<void> = Promise.resolve()
  let pending = 0
  let needRefresh = false
  let latestSeen = 0
  let catchUpQueued = false

  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(task).catch(() => undefined)
  }

  async function refresh(): Promise<void> {
    const snap = await server.getMaster()
    host.replaceFromServer(snap.master, snap.version)
  }

  async function catchUpNow(): Promise<void> {
    if (pending > 0) return // 最后一个本地操作确认后会再来
    try {
      if (needRefresh) {
        needRefresh = false
        await refresh()
        return
      }
      const from = host.getVersion()
      if (latestSeen <= from) return
      const res = await server.opsSince(from)
      if ('reset' in res) {
        await refresh()
        return
      }
      let master = host.getMaster()
      let shifted = false
      for (const r of res.ops) {
        master = applyMasterOp(master ?? emptyMaster(), r.op).master
        shifted ||= opShiftsRows(r.op)
      }
      if (master) host.applyRemote(master, res.version, shifted)
    } catch {
      needRefresh = true
      host.notify('和服务器同步失败，稍后自动重试')
    }
  }

  function scheduleCatchUp(): void {
    if (catchUpQueued) return
    catchUpQueued = true
    enqueue(async () => {
      catchUpQueued = false
      await catchUpNow()
    })
  }

  async function settle(): Promise<void> {
    pending--
    if (pending === 0) await catchUpNow()
  }

  return {
    /** 发送一个已在本地应用过的操作 */
    push(op: MasterOp): void {
      pending++
      enqueue(async () => {
        const base = host.getVersion()
        try {
          const res = await server.postOp({ baseVersion: base, opId: newOpId(), op })
          if (res.applied) {
            if (res.version !== base + 1) needRefresh = true
            host.setVersion(res.version)
          } else if (res.reason === 'unchanged') {
            if (res.version !== base) needRefresh = true
          } else {
            needRefresh = true
            host.notify('总表刚被别处改过，这一步没有保存；已刷新为最新内容，请再做一次')
          }
        } catch (err) {
          needRefresh = true
          host.notify(`这一步没有保存到服务器（${err instanceof Error ? err.message : String(err)}），已刷新为服务器上的内容`)
        }
        await settle()
      })
    },

    /** 整表导入（替换），与其他改动同一队列 */
    importMaster(req: ImportMasterRequest): Promise<boolean> {
      pending++
      return new Promise((resolve) => {
        enqueue(async () => {
          let ok = false
          try {
            const { version } = await server.importMaster(req)
            host.setVersion(version)
            ok = true
          } catch (err) {
            needRefresh = true
            host.notify(`汇总表没有保存到服务器（${err instanceof Error ? err.message : String(err)}）`)
          }
          await settle()
          resolve(ok)
        })
      })
    },

    /** 订阅服务端版本通知；返回取消订阅函数 */
    start(): () => void {
      return server.subscribe((ev) => {
        latestSeen = Math.max(latestSeen, ev.version)
        if (ev.version > host.getVersion()) scheduleCatchUp()
      })
    },

    /** 等队列里的收发全部完成（测试用） */
    idle(): Promise<void> {
      return chain
    },
  }
}

export type MasterSync = ReturnType<typeof createMasterSync>
