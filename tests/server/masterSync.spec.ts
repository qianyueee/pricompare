import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KK_COL_COUNT, applyMasterOp, type MasterCell, type MasterData, type MasterOp } from '@engine/index'
import type { PriServer, VersionEvent } from '@shared/serverApi'
import { DataStore } from '../../src/server/store'
import { createMasterSync, type SyncHost } from '../../src/renderer/src/store/masterSync'

function row(vals: Record<number, MasterCell>) {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}

const seed = (): MasterData => ({
  rows: [row({ 0: 1, 3: 'P-1', 9: 100 }), row({ 0: 2, 3: 'P-2' }), row({ 0: 3, 3: 'P-3' })],
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: 'kk.xlsm',
  importedAt: 1,
})

let dir: string
let store: DataStore

/** 直接调 DataStore 的假服务（省去 HTTP），语义与真接口相同 */
function fakeServer(): PriServer {
  const listeners = new Set<(ev: VersionEvent) => void>()
  store.onVersion((ev) => listeners.forEach((fn) => fn(ev)))
  return {
    session: async () => ({ user: 'local', role: 'editor', version: store.getVersion() }),
    getMaster: async () => structuredClone(store.snapshot()),
    getMasterFile: () => store.getMasterFile(),
    postOp: (req) => store.applyOp(req.baseVersion, req.opId, structuredClone(req.op), { user: 'web', source: 'web' }),
    importMaster: async (req) => ({
      version: await store.importMaster(req.master, req.file, { user: 'web', source: 'web' }, 'imp'),
    }),
    opsSince: async (v) => structuredClone(store.opsSince(v)),
    subscribe(fn) {
      listeners.add(fn)
      fn({ version: store.getVersion(), opId: null, user: '' })
      return () => listeners.delete(fn)
    },
  }
}

/** 模拟一个网页：本地状态 + 同步器 */
function page() {
  const state = { master: null as MasterData | null, version: 0, toasts: [] as string[], shifted: false, refreshed: 0 }
  const host: SyncHost = {
    getMaster: () => state.master,
    getVersion: () => state.version,
    setVersion: (v) => (state.version = v),
    applyRemote: (m, v, shifted) => {
      state.master = m
      state.version = v
      state.shifted ||= shifted
    },
    replaceFromServer: (m, v) => {
      state.master = m
      state.version = v
      state.refreshed++
    },
    notify: (msg) => state.toasts.push(msg),
  }
  const sync = createMasterSync(fakeServer(), host)
  const local = (op: MasterOp) => {
    state.master = applyMasterOp(state.master!, op).master
    sync.push(op)
  }
  return { state, sync, local }
}

const background = (op: MasterOp) =>
  store.applyOp(store.getVersion(), Math.random().toString(36), op, { user: 'local', source: 'cli' })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pri-sync-'))
  store = new DataStore(dir)
  await store.open()
  await store.importMaster(seed(), { name: 'kk.xlsm', b64: '' }, { user: 'local', source: 'cli' }, 'seed')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function open() {
  const p = page()
  const snap = store.snapshot()
  p.state.master = structuredClone(snap.master)
  p.state.version = snap.version
  p.sync.start()
  await p.sync.idle()
  return p
}

describe('网页版与服务的总表同步', () => {
  it('连续本地改动按顺序确认，版本逐一对上，不整表重取', async () => {
    const p = await open()
    p.local({ kind: 'setCells', cells: [{ row: 0, col: 9, value: 1 }] })
    p.local({ kind: 'setCells', cells: [{ row: 1, col: 9, value: 2 }] })
    p.local({ kind: 'deleteRows', rows: [2] })
    await p.sync.idle()
    await p.sync.idle()
    expect(p.state.version).toBe(4)
    expect(p.state.refreshed).toBe(0)
    expect(p.state.master).toEqual(store.snapshot().master)
  })

  it('后台并入的改动推过来后逐条应用到本页', async () => {
    const p = await open()
    await background({ kind: 'setCells', cells: [{ row: 1, col: 11, value: 66 }] })
    await p.sync.idle()
    expect(p.state.version).toBe(2)
    expect(p.state.master!.rows[1]!.cells[11]).toBe(66)
    expect(p.state.refreshed).toBe(0)
    expect(p.state.shifted).toBe(false)
  })

  it('本地改格时后台恰好也改了：两边都保留，本页随后整表对齐', async () => {
    const p = await open()
    // 后台改动发生了，但本页还没收到通知（先取消订阅模拟消息在路上）
    const q = page()
    q.state.master = structuredClone(store.snapshot().master)
    q.state.version = store.getVersion()
    await background({ kind: 'setCells', cells: [{ row: 1, col: 11, value: 66 }] })
    q.local({ kind: 'setCells', cells: [{ row: 0, col: 9, value: 5 }] })
    await q.sync.idle()
    await q.sync.idle()
    expect(store.snapshot().master!.rows[0]!.cells[9]).toBe(5)
    expect(store.snapshot().master!.rows[1]!.cells[11]).toBe(66)
    expect(q.state.master).toEqual(store.snapshot().master)
    expect(q.state.version).toBe(store.getVersion())
    expect(q.state.refreshed).toBe(1)
    await p.sync.idle()
    expect(p.state.master).toEqual(store.snapshot().master)
  })

  it('基于旧版本删行被拒：提示重做，本页恢复成服务上的内容', async () => {
    const q = page()
    q.state.master = structuredClone(store.snapshot().master)
    q.state.version = store.getVersion()
    await background({ kind: 'setCells', cells: [{ row: 1, col: 11, value: 66 }] })
    q.local({ kind: 'deleteRows', rows: [0] })
    await q.sync.idle()
    await q.sync.idle()
    expect(q.state.toasts[0]).toContain('请再做一次')
    expect(q.state.master!.rows).toHaveLength(3)
    expect(q.state.master).toEqual(store.snapshot().master)
  })

  it('别处删了行：本页标记行号已变（撤销作废）', async () => {
    const p = await open()
    await background({ kind: 'deleteRows', rows: [0] })
    await p.sync.idle()
    expect(p.state.shifted).toBe(true)
    expect(p.state.master!.rows.map((r) => r.cells[3])).toEqual(['P-2', 'P-3'])
  })
})
