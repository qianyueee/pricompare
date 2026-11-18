import { describe, expect, it } from 'vitest'
import { KK_COL, KK_COL_COUNT, applyMasterOp, describeMasterOp, opShiftsRows, planAddRows, planMerge } from '@engine/index'
import type { AddRowInput, MasterCell, MasterData, MasterOp, MasterRow } from '@engine/index'
import { makeQuote } from '../fixtures/rows'

function row(vals: Record<number, MasterCell>, origin?: 'intake'): MasterRow {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return origin ? { cells, origin } : { cells }
}

const mkMaster = (rows: MasterRow[]): MasterData => ({
  rows,
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: 'KK询价汇总表.xlsm',
  importedAt: 1,
})

const BATCH = '20261118 Yaoke'
const HC = { batch: BATCH, vendorSlot: KK_COL.vendorSlotStart + 1, vendorId: 'hc', vendorDisplay: 'HC' }
const SKW = { batch: BATCH, vendorSlot: KK_COL.vendorSlotStart + 2, vendorId: 'skw', vendorDisplay: 'SKW' }

const intakeRows: AddRowInput[] = [
  { item: '1', pn: '1330723-000', rev: 'aa', description: 'ADAPTER, LIFT PIN', qty: 1, material: '304', surfaceFinish: '钝化', cleaningSpec: 'L30', process: 'CNC' },
  { item: '2', pn: '1329061-000', rev: 'AA', description: 'CAP, LIFT PIN', qty: 2, material: '6061', surfaceFinish: '本色阳极化', cleaningSpec: 'L30', process: 'CNC' },
  { item: '2', pn: '1329061-000', rev: 'AA', description: 'CAP, LIFT PIN', qty: 5, material: '6061', surfaceFinish: '本色阳极化', cleaningSpec: 'L30', process: 'CNC' },
]

// A 列序号不连续（真实总表就是这样：HC 存档行是 HC1…，中间有跳号），预建行接着最大序号编，不重排
const base = () =>
  mkMaster([
    row({ 0: 'HC1', 1: 'HC报价 PriorTo20260703', 3: '0001', 6: 1, 9: 10 }),
    row({ 0: 7, 1: '20261001 A', 3: '1329061-000', 6: 2, 9: 100, 23: 'AL_6061-T6' }),
    row({ 0: 12, 1: '20261002 B', 3: 'P-3', 6: 1 }),
  ])

describe('预建询价行 addRows', () => {
  it('每个零件每档数量一行：B–G 和规格列填好，价格交期备注空着；A 接着最大序号编，已有序号不动', () => {
    const m = base()
    const r = applyMasterOp(m, { kind: 'addRows', batch: BATCH, rows: intakeRows, origin: 'intake' })
    expect(r.added).toEqual({ add: 3, skip: 0 })
    expect(r.master.rows.slice(0, 3)).toEqual(m.rows)
    const [a, b, c] = r.master.rows.slice(3)
    expect(a!.cells.slice(0, 8)).toEqual([13, BATCH, 1, '1330723-000', 'AA', 'ADAPTER, LIFT PIN', 1, null])
    expect(a!.cells.slice(KK_COL.material, KK_COL.process + 1)).toEqual(['304', '钝化', 'L30', 'CNC'])
    expect(a!.origin).toBe('intake')
    expect([b!.cells[0], b!.cells[KK_COL.qty], c!.cells[0], c!.cells[KK_COL.qty]]).toEqual([14, 2, 15, 5])
    for (const x of [a!, b!, c!]) {
      for (const col of [KK_COL.quoteEach, KK_COL.vendorSlotStart + 1, KK_COL.vendorSlotStart + 2, KK_COL.quoteNo, KK_COL.leadTime, KK_COL.comment]) {
        expect(x.cells[col]).toBeNull()
      }
    }
    expect(opShiftsRows({ kind: 'addRows', batch: BATCH, rows: [] })).toBe(false)
    expect(describeMasterOp({ kind: 'addRows', batch: BATCH, rows: intakeRows })).toBe(`预建询价行 3 条（批次 ${BATCH}）`)
  })

  it('撤销：删掉建的行，回到原表', () => {
    const m = base()
    const r = applyMasterOp(m, { kind: 'addRows', batch: BATCH, rows: intakeRows, origin: 'intake' })
    expect(applyMasterOp(r.master, r.inverse!).master.rows).toEqual(m.rows)
  })

  it('同一组重跑：已有同 P/N + 同数量的跳过，不重复建；输入里重复的也只建一次', () => {
    const m = base()
    const once = applyMasterOp(m, { kind: 'addRows', batch: BATCH, rows: intakeRows, origin: 'intake' }).master
    const again = applyMasterOp(once, { kind: 'addRows', batch: BATCH, rows: [...intakeRows, intakeRows[0]!], origin: 'intake' })
    expect(again.added).toEqual({ add: 0, skip: 4 })
    expect(again.inverse).toBeNull()
    expect(again.master).toBe(once)
    const plan = planAddRows(m, BATCH, [intakeRows[0]!, intakeRows[0]!])
    expect(plan.items.map((i) => i.kind)).toEqual(['add', 'skip'])
  })

  it('底部有只编了号的预编号空行 → 先占用它们，沿用原序号', () => {
    const m = mkMaster([row({ 0: 1, 1: '20261001 A', 3: 'X', 6: 1 }), row({ 0: 2 }), row({ 0: 3 })])
    const r = applyMasterOp(m, { kind: 'addRows', batch: BATCH, rows: intakeRows, origin: 'intake' })
    expect(r.master.rows.map((x) => [x.cells[0], x.cells[KK_COL.pn]])).toEqual([
      [1, 'X'],
      [2, '1330723-000'],
      [3, '1329061-000'],
      [4, '1329061-000'],
    ])
    // 撤销：占用的预编号行清回只剩序号
    expect(applyMasterOp(r.master, r.inverse!).master.rows.map((x) => x.cells)).toEqual(m.rows.map((x) => x.cells))
  })
})

describe('报价并入预建行', () => {
  const withIntake = () => applyMasterOp(base(), { kind: 'addRows', batch: BATCH, rows: intakeRows, origin: 'intake' }).master

  it('HC 报价落到预建行上（同 P/N + 同数量），不新建行；规格列已有的不动，空的才填', () => {
    const m = withIntake()
    const plan = planMerge(m, [
      makeQuote('1330723-000', { qty: 1, amount: 2260, lead: '20Days', material: 'CRES_304' }),
      makeQuote('1329061-000', { qty: 5, amount: 180 }),
    ], HC)
    expect(plan.appendCount).toBe(0)
    expect(plan.actions.map((a) => a.excelRow)).toEqual([5, 7])
    const cols = plan.actions[0]!.changes.map((c) => c.col)
    expect(cols).toContain(HC.vendorSlot)
    expect(cols).toContain(KK_COL.leadTime)
    expect(cols).not.toContain(KK_COL.material)
  })

  it('凯维的规格写法不覆盖预建行（按图纸填好的），普通行照旧覆盖', () => {
    const m = withIntake()
    const q = makeQuote('1329061-000', { qty: 2, amount: 90 })
    q.cleaningSpec = '30级'
    q.surfaceFinish = '本色阳极化（暂时）'
    q.size = '21*7*7'
    const plan = planMerge(m, [q], SKW)
    const changes = plan.actions[0]!.changes
    expect(plan.actions[0]!.excelRow).toBe(6) // 本组的预建行，不是上面 20261001 A 那行同料号同数量的
    expect(changes.find((c) => c.col === KK_COL.cleaningSpec)).toBeUndefined()
    expect(changes.find((c) => c.col === KK_COL.surfaceFinish)).toBeUndefined()
    expect(changes.find((c) => c.col === KK_COL.size)?.to).toBe('21*7*7') // 空着的照填

    // 普通行（不是预建的）：凯维照旧覆盖别家写的规格
    const plain = mkMaster([row({ 0: 1, 1: BATCH, 3: 'P-1', 6: 1, 9: 50, 25: 'SPECIFICATION 0577777-000 LEVEL 30' })])
    const q2 = makeQuote('P-1', { qty: 1, amount: 40 })
    q2.cleaningSpec = '30级'
    const p2 = planMerge(plain, [q2], SKW)
    expect(p2.actions[0]!.changes.find((c) => c.col === KK_COL.cleaningSpec)?.to).toBe('30级')
  })

  it('同 P/N + 同数量的空行有好几处时先落本组的行，哪怕别组的在更下面', () => {
    const m = withIntake()
    const later = mkMaster([...m.rows, row({ 0: 99, 1: '20261119 Next', 3: '1330723-000', 6: 1 }, 'intake')])
    const plan = planMerge(later, [makeQuote('1330723-000', { qty: 1, amount: 2000 })], HC)
    expect(plan.actions[0]!.excelRow).toBe(5)
    // 本组没有对得上的行 → 照旧自底向上找别组的
    const other = planMerge(later, [makeQuote('1330723-000', { qty: 1, amount: 2000 })], { ...HC, batch: '20261120 Zed' })
    expect(other.actions[0]!.excelRow).toBe(later.rows.length + 1)
  })

  it('客户询价没写数量：第一档报价落到预建行并填上数量；多出来的数量档照预建行的料号和规格新建，也记成预建行', () => {
    const m = applyMasterOp(base(), {
      kind: 'addRows',
      batch: BATCH,
      rows: [{ item: '1', pn: 'P-9', rev: 'A', description: 'BRACKET', qty: null, material: '6061', surfaceFinish: 'none', cleaningSpec: 'L30', process: 'CNC' }],
      origin: 'intake',
    }).master
    expect(m.rows[3]!.cells[KK_COL.qty]).toBeNull()
    const plan = planMerge(m, [makeQuote('P-9', { qty: 1, amount: 100 }), makeQuote('P-9', { qty: 3, amount: 80, material: 'AL_6061-T6' })], HC)
    expect(plan.actions.map((a) => [a.kind, a.excelRow])).toEqual([['fill', 5], ['append', 6]])
    const next = applyMasterOp(m, { kind: 'merge', quotes: [makeQuote('P-9', { qty: 1, amount: 100 }), makeQuote('P-9', { qty: 3, amount: 80, material: 'AL_6061-T6' })], options: HC }).master
    const [a, b] = next.rows.slice(3)
    expect([a!.cells[KK_COL.qty], a!.cells[HC.vendorSlot]]).toEqual([1, 100])
    expect(b!.origin).toBe('intake')
    expect(b!.cells.slice(0, 7)).toEqual([14, BATCH, 1, 'P-9', 'A', 'BRACKET', 3])
    expect(b!.cells.slice(KK_COL.material, KK_COL.process + 1)).toEqual(['6061', 'none', 'L30', 'CNC'])
    expect(b!.cells[HC.vendorSlot]).toBe(80)
    // 凯维之后报同样两档：落到这两行，不再新建，规格也不改
    const q = makeQuote('P-9', { qty: 3, amount: 70 })
    q.cleaningSpec = '30级'
    const p2 = planMerge(next, [makeQuote('P-9', { qty: 1, amount: 90 }), q], SKW)
    expect(p2.actions.map((x) => [x.kind, x.excelRow])).toEqual([['fill', 5], ['fill', 6]])
    expect(p2.actions[1]!.changes.find((c) => c.col === KK_COL.cleaningSpec)).toBeUndefined()
  })

  it('改格、删行再恢复、并入之后，预建行的来历标记都还在', () => {
    const m = withIntake()
    const ops: MasterOp[] = [
      { kind: 'setCells', cells: [{ row: 3, col: KK_COL.comment, value: 'x' }] },
      { kind: 'merge', quotes: [makeQuote('1330723-000', { qty: 1, amount: 1 })], options: HC },
    ]
    let cur = m
    for (const op of ops) cur = applyMasterOp(cur, op).master
    expect(cur.rows.slice(3).map((r) => r.origin)).toEqual(['intake', 'intake', 'intake'])
    const del = applyMasterOp(cur, { kind: 'deleteRows', rows: [4] })
    expect(del.master.rows.slice(3).map((r) => r.origin)).toEqual(['intake', 'intake'])
    const back = applyMasterOp(del.master, del.inverse!)
    expect(back.master.rows.slice(3).map((r) => r.origin)).toEqual(['intake', 'intake', 'intake'])
  })
})
