import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { FIXTURE_PNS, makeMasterFile } from '../fixtures/buildFixtures'
import { makeQuote } from '../fixtures/rows'
import {
  CANONICAL_LAYOUT,
  KK_HEADERS,
  SEED_VENDORS,
  amountCols,
  applyMerge,
  buildMasterWorkbook,
  buildNegoLine,
  buildNegoSummary,
  cleanMasterAmounts,
  detectKKLayout,
  isMasterWorkbook,
  parseMasterWorkbook,
  planMerge,
  readWorkbook,
  resolveVendorSlot,
} from '@engine/index'

describe('汇总表列布局（按表头定位）', () => {
  it('模板原样 → 恒等布局：33 列、供应商 I–N、各逻辑列 = 模板下标', () => {
    const L = CANONICAL_LAYOUT
    expect(L.colCount).toBe(33)
    expect(L.vendorSlots.map((v) => `${v.label}@${v.col}`)).toEqual(['Mao@8', 'HC@9', 'SKW@10', 'BY@11', 'YJ@12', 'JM@13'])
    expect([L.pn, L.qty, L.quoteEach, L.usVendor, L.quoteEa, L.quoteNo, L.leadTime, L.comment, L.baseId]).toEqual([3, 6, 7, 14, 20, 21, 22, 29, 32])
    expect(L.costCols).toEqual([16, 17, 18, 19])
    expect(amountCols(L)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  })

  it('SKW 后插入新供应商 CL：右侧列整体 +1，CL 识别为供应商列，得分仍满', () => {
    const headers = [...KK_HEADERS]
    headers.splice(11, 0, 'CL')
    const d = detectKKLayout(headers)!
    expect(d.score).toBe(33)
    const L = d.layout
    expect(L.colCount).toBe(34)
    expect(L.vendorSlots.map((v) => `${v.label}@${v.col}`)).toEqual(['Mao@8', 'HC@9', 'SKW@10', 'CL@11', 'BY@12', 'YJ@13', 'JM@14'])
    expect([L.pn, L.qty, L.quoteEach, L.usVendor, L.quoteEa, L.quoteNo, L.leadTime, L.material, L.comment, L.baseId]).toEqual([3, 6, 7, 15, 21, 22, 23, 24, 30, 33])
    expect(L.costCols).toEqual([17, 18, 19, 20])
    expect(L.headers[11]).toBe('CL')
    expect(resolveVendorSlot(L, SEED_VENDORS.find((v) => v.id === 'hc')!)).toBe(9)
    expect(resolveVendorSlot(L, SEED_VENDORS.find((v) => v.id === 'by')!)).toBe(12) // 旧列字母 L 已是 CL，按表头名找到 M
    expect(resolveVendorSlot(L, { display: 'cl' })).toBe(11) // 未注册的家按名字找同名列
    expect(resolveVendorSlot(L, { display: 'NOPE' })).toBeNull()
  })

  it('表头文字容差：换行/大小写/多余空格；缺少的模板列为 -1；没有 P/N 或数量 → null', () => {
    const d = detectKKLayout(['no.', 'NAME', 'Item', 'p/n', 'Rev', 'Description', "q'ty", 'Quote \r\n(each)', 'Mao', 'HC', 'SKW', 'US Vendor (US$)', 'Lead  Time'])!
    expect(d.layout.pn).toBe(3)
    expect(d.layout.qty).toBe(6)
    expect(d.layout.quoteEach).toBe(7)
    expect(d.layout.vendorSlots.map((v) => v.col)).toEqual([8, 9, 10])
    expect(d.layout.leadTime).toBe(12)
    expect(d.layout.comment).toBe(-1)
    expect(detectKKLayout(['No.', 'Name', 'Item', 'Rev'])).toBeNull()
  })

  it('CL 布局的真实流程：识别为汇总 → 并入落对列 → 清洗覆盖 CL → 比价含 CL → 补丁导出回读一致', async () => {
    const original = await makeMasterFile({ extraVendor: 'CL' })
    const pw = readWorkbook(original)
    expect(isMasterWorkbook(pw)).toBe(true)
    const master = parseMasterWorkbook(pw, 'm.xlsx')!
    const L = master.layout
    expect(L.colCount).toBe(34)
    expect(master.rows[0]!.cells[L.leadTime]).toBe('22Days') // 物理 23（X 列）
    expect(master.rows[1]!.cells[11]).toBe(88) // CL 列原值
    // 清洗覆盖 CL 列与右移后的对客报价列
    const cleaned = cleanMasterAmounts({ ...master, rows: master.rows.map((r, i) => (i === 1 ? { cells: r.cells.map((v, c) => (c === 11 ? '￥88.00' : v)) } : r)) })
    expect(cleaned.master.rows[1]!.cells[11]).toBe(88)
    // SKW 报价并入行 0（K 空）：K 列价、交期落物理 23（K 在 J 右侧 → 追加在后）、单号落 22、材料落 24
    const plan = planMerge(master, [makeQuote(FIXTURE_PNS[0]!, { qty: 10, amount: 77, lead: '9', quoteNo: 'KV20260919A', material: '304' })], {
      batch: '20260919 T',
      vendorSlot: resolveVendorSlot(L, SEED_VENDORS.find((v) => v.id === 'skw')!)!,
      vendorId: 'skw',
      vendorDisplay: 'SKW',
    })
    expect(plan.fillCount).toBe(1)
    const merged = applyMerge(master, plan)
    const r = merged.rows[0]!
    expect(r.cells[10]).toBe(77)
    expect(r.cells[L.leadTime]).toBe('22Days/9Days')
    expect(r.cells[L.quoteNo]).toBe('KV20260919A')
    expect(r.cells[L.material]).toBe('304')
    expect(r.cells[11]).toBeNull() // CL 不受影响
    // CL 家报价并入到 CL 列（未注册供应商按表头名落列；CL 在 SKW 右侧 → 交期继续追加）
    const plan2 = planMerge(merged, [makeQuote(FIXTURE_PNS[0]!, { qty: 10, amount: 50, lead: '7' })], {
      batch: '20260919 T',
      vendorSlot: resolveVendorSlot(L, { display: 'CL' })!,
      vendorId: 'cl',
      vendorDisplay: 'CL',
    })
    expect(plan2.fillCount).toBe(1)
    const merged2 = applyMerge(merged, plan2)
    expect(merged2.rows[0]!.cells[11]).toBe(50)
    expect(merged2.rows[0]!.cells[L.leadTime]).toBe('22Days/9Days/7Days')
    // 比价：供应商含 CL
    const summary = buildNegoSummary([buildNegoLine(merged2, 0), buildNegoLine(merged2, 1)], L.vendorSlots)
    expect(summary.vendors.map((v) => v.label)).toEqual(['HC', 'SKW', 'CL'])
    // 补丁导出 → 回读布局一致、值落在物理列
    const out = await buildMasterWorkbook(merged2, original)
    expect(out.mode).toBe('patch')
    const re = parseMasterWorkbook(readWorkbook(out.buffer), 'o.xlsx')!
    expect(re.layout.vendorSlots.map((v) => v.label)).toEqual(['Mao', 'HC', 'SKW', 'CL', 'BY', 'YJ', 'JM'])
    expect(re.rows[0]!.cells[11]).toBe(50)
    expect(re.rows[0]!.cells[re.layout.quoteNo]).toBe('KV20260919A')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(out.buffer)
    const ws = wb.getWorksheet('KK询价汇总')!
    expect(ws.getCell('L1').value).toBe('CL')
    expect(ws.getCell('L2').value).toBe(50)
    expect(ws.getCell('X2').value).toBe('22Days/9Days/7Days') // 交期在 X 列（模板 W 右移一格）
    expect(ws.getCell('W2').value).toBe('KV20260919A')
    expect(ws.getCell('L3').value).toBe(88) // 既有 CL 价原样
  })
})
