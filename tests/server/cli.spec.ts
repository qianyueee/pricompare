import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KK_COL, KK_COL_COUNT, type MasterCell, type MasterData } from '@engine/index'
import { DEFAULT_AUTH } from '../../src/server/auth'
import { runCli } from '../../src/server/cliRun'
import { createHandler } from '../../src/server/http'
import { DataStore } from '../../src/server/store'
import { FILE_B_PRICES, FIXTURE_PNS, makeFileB } from '../fixtures/buildFixtures'

function row(vals: Record<number, MasterCell>) {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}

const BATCH = '20261012 Test'
const seedMaster = (): MasterData => ({
  rows: [
    row({ 0: 1, 1: '20261001 Old', 3: 'X-1', 6: 1, 10: 50 }),
    row({ 0: 2, 1: BATCH, 2: 1, 3: FIXTURE_PNS[0]!, 6: 10, 10: 40 }),
    row({ 0: 3, 1: BATCH, 2: 2, 3: FIXTURE_PNS[1]!, 6: 10 }),
  ],
  sheetName: 'KK询价汇总',
  passthrough: [],
  sourceFileName: 'KK询价汇总表20261012.xlsm',
  importedAt: 1,
})

let dir: string
let store: DataStore
let server: Server
let closeHandler: () => void
let url: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pri-cli-'))
  store = new DataStore(join(dir, 'data'))
  await store.open()
  await store.importMaster(seedMaster(), { name: 'kk.xlsm', b64: '' }, { user: 'local', source: 'cli' }, 'seed')
  const web = join(dir, 'web')
  await mkdir(web, { recursive: true })
  await writeFile(join(web, 'index.html'), '<html></html>')
  const h = createHandler({ store, auth: () => DEFAULT_AUTH, staticDir: web })
  closeHandler = h.close
  server = createServer((req, res) => void h.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  closeHandler()
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

async function cli(...args: string[]) {
  const lines: string[] = []
  const errors: string[] = []
  const code = await runCli([...args, '--url', url], {
    out: (s) => lines.push(s),
    err: (s) => errors.push(s),
    env: {},
  })
  return { code, out: lines.join('\n'), err: errors.join('\n') }
}

const master = () => store.snapshot().master!
const cell = (excelRow: number, col: number) => master().rows[excelRow - 2]!.cells[col]

/** 华臣风格报价单：H 列 Quote(each) 填了残留旧价并隐藏（真实模板就是这样） */
async function hcFileWithStaleH(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await makeFileB({ quoteNo: `询价 ${BATCH}` }))
  const ws = wb.worksheets[0]!
  FIXTURE_PNS.forEach((_, i) => (ws.getRow(4 + i).getCell(8).value = 452))
  ws.getColumn(8).hidden = true
  const path = join(dir, `HCQuote20261013 -询价 ${BATCH}.xlsx`)
  await writeFile(path, Buffer.from(await wb.xlsx.writeBuffer()))
  return path
}

describe('pricompare 命令行', () => {
  it('analyze：隐藏列当不存在，取可见的 Quote Each RMB', async () => {
    const r = await cli('analyze', await hcFileWithStaleH())
    expect(r.code).toBe(0)
    const info = JSON.parse(r.out)
    expect(info.priceColumn).toMatch(/^J/)
    expect(info.hiddenColumns).toContain('H')
    expect(info.rows.map((x: { price: number }) => x.price)).toEqual(FILE_B_PRICES)
  })

  it('analyze：单价列被识别到隐藏列时自动改用可见列并提示', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Quote')
    ws.getRow(1).values = ['P/N', "Q'ty", 'Quote (each)', 'Price RMB']
    ;['A-1', 'A-2', 'A-3'].forEach((pn, i) => (ws.getRow(2 + i).values = [pn, 5, 999, 10 + i]))
    ws.getColumn(3).hidden = true
    const path = join(dir, 'q.xlsx')
    await writeFile(path, Buffer.from(await wb.xlsx.writeBuffer()))
    const info = JSON.parse((await cli('analyze', path)).out)
    expect(info.priceColumn).toMatch(/^D/)
    expect(info.warnings.join()).toContain('隐藏列')
    expect(info.rows.map((x: { price: number }) => x.price)).toEqual([10, 11, 12])
    // 人工指定的列最后生效
    const forced = JSON.parse((await cli('analyze', path, '--price-col', 'C', '--map', 'remark=D')).out)
    expect(forced.rows[0].price).toBe(999)
    expect(forced.rows[0].remark).toBe('10')
    expect((await cli('analyze', path, '--map', 'lead=D')).err).toContain('--map 写法不对')
  })

  it('preview 不改总表；merge 按桌面版规则并入，历史记来源', async () => {
    const file = await hcFileWithStaleH()
    const pre = await cli('preview', file, '--vendor', 'hc', '--batch', BATCH)
    expect(pre.code).toBe(0)
    expect(pre.out).toContain('更新 2 行 · 新增 7 行')
    expect(store.getVersion()).toBe(1)

    const r = await cli('merge', file, '--vendor', 'HC', '--batch', BATCH, '--source', 'hourly')
    expect(r.code, r.err).toBe(0)
    expect(store.getVersion()).toBe(2)
    expect(cell(3, KK_COL.vendorSlotStart + 1)).toBe(FILE_B_PRICES[0]) // J3 HC
    expect(cell(3, KK_COL.vendorSlotStart + 2)).toBe(40) // K3 SKW 原值不动
    expect(master().rows).toHaveLength(10)
    expect(cell(11, KK_COL.pn)).toBe(FIXTURE_PNS[8])
    expect(cell(11, KK_COL.name)).toBe(BATCH)
    const hist = await cli('history')
    expect(hist.out).toMatch(/v2 .* local\/hourly/)

    // 同一份再并一次：全部已在表内，不产生新版本
    const again = await cli('merge', file, '--vendor', 'hc', '--batch', BATCH)
    expect(again.out).toContain('跳过 9 行')
    expect(store.getVersion()).toBe(2)
  })

  it('不在注册表里的供应商一律拒绝', async () => {
    const r = await cli('merge', await hcFileWithStaleH(), '--vendor', 'RC Precision', '--batch', BATCH)
    expect(r.code).toBe(1)
    expect(r.err).toContain('先问人')
    expect(store.getVersion()).toBe(1)
  })

  it('没识别出单价列时不并入', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.getRow(1).values = ['P/N', "Q'ty", 'Note']
    ws.getRow(2).values = ['A-1', 5, 'call me']
    const path = join(dir, 'noprice.xlsx')
    await writeFile(path, Buffer.from(await wb.xlsx.writeBuffer()))
    const r = await cli('merge', path, '--vendor', 'hc', '--batch', BATCH)
    expect(r.code).toBe(1)
    expect(r.err).toContain('--price-col')
    expect(store.getVersion()).toBe(1)
  })

  it('merge-rows：正文里的报价（宸立）填进已有行', async () => {
    const rows = JSON.stringify([
      { pn: FIXTURE_PNS[1], qty: 10, price: '￥88', lead: '15天', remark: '含税' },
    ])
    const dry = await cli('merge-rows', '--rows', rows, '--vendor', 'cl', '--batch', BATCH, '--dry-run')
    expect(dry.out).toContain('填价 第4行')
    expect(store.getVersion()).toBe(1)
    const r = await cli('merge-rows', '--rows', rows, '--vendor', 'cl', '--batch', BATCH)
    expect(r.code, r.err).toBe(0)
    expect(cell(4, KK_COL.vendorSlotStart + 3)).toBe(88) // L4 CL
    expect(cell(4, KK_COL.comment)).toBe('含税')
  })

  it('rows / batches 查行；set 填「无」、追加备注，P/N 对不上就拒绝', async () => {
    const rows = await cli('rows', '--batch', BATCH)
    expect(rows.out).toContain('总表版本 1，2 行')
    expect(rows.out).toContain(`D=${FIXTURE_PNS[0]}`)
    const groups = await cli('batches')
    expect(groups.out).toContain(`「${BATCH}」第3–4行 2 行；已填：SKW 1/2`)

    const wrong = await cli('set', '--row', '3', '--col', 'J', '--value', '无', '--expect-pn', 'NOPE')
    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain('先用 rows 重新查行号')

    const cells = JSON.stringify([
      { row: 3, col: 'J', value: '无', expectPn: FIXTURE_PNS[0] },
      { row: 4, col: 'J', value: '无', expectPn: FIXTURE_PNS[1] },
      { row: 4, col: 'AD', value: 'HC 20261013:做不了', append: true },
    ])
    const ok = await cli('set', '--cells', cells, '--source', 'hourly')
    expect(ok.code, ok.err).toBe(0)
    expect(cell(3, KK_COL.vendorSlotStart + 1)).toBe('无')
    expect(cell(4, KK_COL.comment)).toBe('HC 20261013:做不了')
    await cli('set', '--row', '4', '--col', 'AD', '--value', 'SKW:无图纸', '--append')
    expect(cell(4, KK_COL.comment)).toBe('HC 20261013:做不了; SKW:无图纸')
    await cli('set', '--row', '4', '--col', 'K', '--value', '¥1,200')
    expect(cell(4, KK_COL.vendorSlotStart + 2)).toBe(1200)
  })

  it('dump 逐格打印并标出隐藏列', async () => {
    const r = await cli('dump', await hcFileWithStaleH(), '--limit', '3')
    expect(r.code).toBe(0)
    expect(r.out).toContain('隐藏列：H')
    expect(r.out).toContain('H(隐)=452')
    expect(r.out).toContain('J=56.7')
  })
})
