import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_LAYOUT,
  KK_COL_COUNT,
  buildNegoLine,
  buildNegoSummary,
  buildNegoWorkbook,
  carryQtyFor,
  dedupeNegoLinesByPn,
  negoToTsv,
  buildNegoSheetSpec,
  negoDefinedNames,
  negoFormulas,
  negoSheetColumns,
  negoSheetDataXml,
  negoTableXml,
  pnTiers,
  resolveNegoInput,
} from '@engine/index'
import type { MasterCell, MasterData, MasterRow } from '@engine/index'

function row(vals: Record<number, MasterCell>): MasterRow {
  const cells = Array.from({ length: KK_COL_COUNT }, () => null as MasterCell)
  for (const [k, v] of Object.entries(vals)) cells[Number(k)] = v
  return { cells }
}

const mkMaster = (rows: MasterRow[]): MasterData => ({
  rows,
  sheetName: 'KK询价汇总',
  layout: CANONICAL_LAYOUT,
  passthrough: [],
  sourceFileName: null,
  importedAt: null,
})

describe('pnTiers 数量档', () => {
  // 列：1=批次 3=P/N 6=Q'ty 9=HC(J)
  const master = mkMaster([
    row({ 0: 1, 1: 'B1', 3: 'X-1', 6: 1, 9: 100 }),
    row({ 0: 2, 1: 'B1', 3: 'X-1', 6: 3, 9: 90 }),
    row({ 0: 3, 1: 'B2', 3: 'x-1 ', 6: 1, 9: 80 }), // 同数量再询（大小写/空格不同）
    row({ 0: 4, 1: 'B2', 3: 'OTHER', 6: 5, 9: 70 }),
    row({ 0: 5, 1: 'B3', 3: 'X-1', 9: 60 }), // 数量空 → null 档
    row({ 0: 6 }), // 预编号空行不参与
  ])

  it('归一化匹配、同数量取最近一行、按数量升序、空数量排最后', () => {
    const tiers = pnTiers(master, ' x-1')
    expect(tiers.map((t) => t.qty)).toEqual([1, 3, null])
    // qty=1 的两行取最靠下（更近）的 B2 行
    expect(tiers[0]).toMatchObject({ rowIndex: 2, excelRow: 4, batch: 'B2' })
    expect(tiers[1]).toMatchObject({ rowIndex: 1, batch: 'B1' })
  })

  it('查不到与空输入', () => {
    expect(pnTiers(master, 'NOPE')).toEqual([])
    expect(pnTiers(master, '  ')).toEqual([])
  })
})

describe('buildNegoLine 取行', () => {
  const master = mkMaster([
    row({ 3: 'P-1', 4: 'AA', 5: 'PLATE, FX', 6: 5, 8: 56.7, 9: '￥1,360.00', 10: 'TDB' }),
  ])

  it('槽位数值经金额清洗；TDB/空 → null；qty 可覆盖', () => {
    const line = buildNegoLine(master, 0)
    expect(line.pn).toBe('P-1')
    expect(line.rev).toBe('AA')
    expect(line.qty).toBe(5)
    expect(line.unit[8]).toBe(56.7)
    expect(line.unit[9]).toBe(1360) // 文本金额
    expect(line.unit[10]).toBeNull() // TDB
    expect(line.unit[11]).toBeNull() // 空槽
    expect(buildNegoLine(master, 0, 12).qty).toBe(12)
    expect(buildNegoLine(master, 0, null).qty).toBeNull()
  })
})

describe('buildNegoSummary 汇总', () => {
  const master = mkMaster([
    row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
    row({ 3: 'A-2', 6: 5, 9: 100 }), // SKW 缺报
  ])
  const summary = buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)])

  it('供应商 = 有报价的槽（按列序取表头名）', () => {
    expect(summary.vendors).toEqual([
      { slot: 9, label: 'HC' },
      { slot: 10, label: 'SKW' },
    ])
  })

  it('每行最低单价与总价（含浮点噪声消除）', () => {
    expect(summary.lines[0]).toMatchObject({
      minUnit: 45,
      totals: { 9: 567, 10: 450 }, // 56.7×10 精确为 567
      optimalTotal: 450,
    })
    expect(summary.lines[1]).toMatchObject({
      minUnit: 100,
      totals: { 9: 500, 10: null }, // 100×5
      optimalTotal: 500,
    })
  })

  it('各家合计（缺报行不计入并计数）与最优组合合计', () => {
    expect(summary.perVendor).toEqual([
      { slot: 9, label: 'HC', sum: 1067, missing: 0 }, // 567+500
      { slot: 10, label: 'SKW', sum: 450, missing: 1 },
    ])
    expect(summary.optimalSum).toBe(950) // 450+500
  })

  it('数量为空 → 各总价与最优为 null 并计缺', () => {
    const s = buildNegoSummary([buildNegoLine(master, 0, null)])
    expect(s.lines[0]!.totals[9]).toBeNull()
    expect(s.lines[0]!.optimalTotal).toBeNull()
    expect(s.perVendor.every((v) => v.missing === 1)).toBe(true)
    expect(s.optimalSum).toBe(0)
  })

  it('空面板', () => {
    const s = buildNegoSummary([])
    expect(s.vendors).toEqual([])
    expect(s.lines).toEqual([])
    expect(s.optimalSum).toBe(0)
  })
})

describe('resolveNegoInput 自由输入解析（比价页编号+数量格）', () => {
  const master = mkMaster([
    row({ 1: 'B1', 3: 'L-1', 6: 1, 9: 100 }),
    row({ 1: 'B1', 3: 'L-1', 6: 6, 9: 80 }),
    row({ 1: 'B1', 3: 'L-1', 6: 12, 9: 70 }),
  ])

  it('数量未填 → 只回档位列表（数量格 1/6/12 占位提示用），不出价', () => {
    const r = resolveNegoInput(master, 'L-1', null)
    expect(r.tiers.map((t) => t.qty)).toEqual([1, 6, 12])
    expect(r.usedTier).toBeNull()
    expect(r.line).toBeNull()
  })

  it('精确命中档位（编号大小写空格不敏感）', () => {
    const r = resolveNegoInput(master, ' l-1 ', 6)
    expect(r.usedTier?.qty).toBe(6)
    expect(r.line?.unit[9]).toBe(80)
    expect(r.line?.qty).toBe(6)
  })

  it('不在档上 → 阶梯语义取 ≤数量 的最大档，总价仍按输入数量', () => {
    const r = resolveNegoInput(master, 'L-1', 8)
    expect(r.usedTier?.qty).toBe(6)
    expect(r.line?.unit[9]).toBe(80)
    expect(r.line?.qty).toBe(8)
  })

  it('比最小档还小 → 取最小档；未找到编号 → 全空', () => {
    expect(resolveNegoInput(master, 'L-1', 0.5).usedTier?.qty).toBe(1)
    const miss = resolveNegoInput(master, 'NOPE', 5)
    expect(miss.tiers).toEqual([])
    expect(miss.usedTier).toBeNull()
    expect(miss.line).toBeNull()
  })
})

describe('buildNegoWorkbook 比价表导出（xlsx）', () => {
  it('NEGO 布局 + RMB 表头 + 数量在描述后 + 最低价绿高亮 + 合计行', async () => {
    const master = mkMaster([
      row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
      row({ 3: 'A-2', 6: 5, 9: 100 }),
    ])
    const summary = buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await buildNegoWorkbook(summary))
    const ws = wb.getWorksheet('NEGO')!
    expect(ws.getRow(1).values).toEqual([
      undefined,
      'P/N',
      'Rev',
      'Description',
      "Q'ty",
      'HC Unit (RMB)',
      'SKW Unit (RMB)',
      'Min (RMB)',
      'HC Total (RMB)',
      'SKW Total (RMB)',
      'Optimal (RMB)',
    ])
    expect(ws.getCell('A2').value).toBe('A-1')
    expect(ws.getCell('D2').value).toBe(10) // 数量在描述后
    expect(ws.getCell('F2').value).toBe(45) // SKW 单价
    expect(ws.getCell('G2').value).toBe(45) // Min
    expect(ws.getCell('J2').value).toBe(450) // Optimal
    expect(ws.getCell('E3').value).toBe(100)
    // 合计行：各家总额 + 最优（表内全英文 → Total）
    expect(ws.getCell('A4').value).toBe('Total')
    expect(ws.getCell('H4').value).toBe(1067)
    expect(ws.getCell('I4').value).toBe(450)
    expect(ws.getCell('J4').value).toBe(950)
    // 本行最低单价绿色填充
    const fill = ws.getCell('F2').fill as { fgColor?: { argb?: string } }
    expect(fill?.fgColor?.argb).toBe('FFC6EFCE')
  })
})

describe('negoToTsv 剪贴板表格', () => {
  it('NEGO 同构布局：表头 / 行 / 合计行', () => {
    const master = mkMaster([
      row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
      row({ 3: 'A-2', 6: 5, 9: 100 }),
    ])
    const tsv = negoToTsv(buildNegoSummary([buildNegoLine(master, 0), buildNegoLine(master, 1)]))
    const lines = tsv.split('\n')
    expect(lines[0]).toBe("P/N\tRev\tDescription\tQ'ty\tHC Unit\tSKW Unit\tMin\tHC Total\tSKW Total\tOptimal")
    expect(lines[1]).toBe('A-1\t\t\t10\t56.7\t45\t45\t567\t450\t450')
    expect(lines[2]).toBe('A-2\t\t\t5\t100\t\t100\t500\t\t500')
    expect(lines[3]).toBe('Total\t\t\t\t\t\t\t1067\t450\t950')
  })
})

describe('比价页：同零件号合并与数量 Tab 继承', () => {
  it('dedupeNegoLinesByPn：同零件号只留先出现的一行（忽略大小写/空白），空行保留', () => {
    const out = dedupeNegoLinesByPn([
      { pn: 'A-1', qty: 3 },
      { pn: 'B-2', qty: null },
      { pn: ' a-1 ', qty: 9 },
      { pn: '', qty: null },
      { pn: 'B-2', qty: 5 },
      { pn: '', qty: null },
    ])
    expect(out).toEqual([
      { pn: 'A-1', qty: 3 },
      { pn: 'B-2', qty: null },
      { pn: '', qty: null },
      { pn: '', qty: null },
    ])
  })

  it('carryQtyFor：下一件在总表里恰有该数量档才继承，否则 null', () => {
    const master = mkMaster([
      row({ 3: 'L-1', 6: 1, 9: 10 }),
      row({ 3: 'L-1', 6: 6, 9: 8 }),
      row({ 3: 'M-1', 6: 3, 9: 5 }),
    ])
    expect(carryQtyFor(master, 'L-1', 6)).toBe(6)
    expect(carryQtyFor(master, 'L-1', 3)).toBeNull() // 无 3 档 → 留空手填
    expect(carryQtyFor(master, 'M-1', 3)).toBe(3)
    expect(carryQtyFor(master, 'NOPE', 3)).toBeNull()
    expect(carryQtyFor(master, 'L-1', null)).toBeNull()
  })
})

describe('导出 NEGO 活表：buildNegoSheetSpec（与比价页同逻辑的缓存值）', () => {
  // A-1 有 10 档（HC 56.7 / SKW 45）与 50 档（HC 40 / SKW 42）；A-2 只有 5 档且只 HC 报价；A-3 HC 是文字 TDB；A-5 两家同价
  const master = () =>
    mkMaster([
      row({ 3: 'A-1', 6: 10, 9: 56.7, 10: 45 }),
      row({ 3: 'A-1', 6: 50, 9: 40, 10: 42 }),
      row({ 3: 'A-2', 6: 5, 9: 100 }),
      row({ 3: 'A-3', 6: 2, 9: 'TDB' }),
      row({ 3: 'A-5', 6: 1, 9: 7, 10: 7 }),
    ])

  it('供应商列 = 总表里出现过报价的列；输入去重去空；精确命中档 / 只一家 / 文字价 / 未找到', () => {
    const spec = buildNegoSheetSpec(master(), [
      { pn: 'A-1', qty: 10 },
      { pn: ' a-1 ', qty: 99 }, // 同零件号 → 丢弃
      { pn: 'A-2', qty: 5 },
      { pn: 'A-3', qty: 2 },
      { pn: 'NOPE', qty: 3 },
      { pn: '', qty: 1 },
      { pn: 'A-5', qty: 4 },
    ])
    expect(spec.masterSheet).toBe('KK询价汇总')
    expect(spec.vendors).toEqual([
      { col: 9, label: 'HC' },
      { col: 10, label: 'SKW' },
    ])
    expect(spec.pn).toBe(3)
    expect(spec.qty).toBe(6)
    expect(spec.maxRow).toBe(5000)
    expect(spec.rows.map((r) => r.pn)).toEqual(['A-1', 'A-2', 'A-3', 'NOPE', 'A-5'])
    const [a1, a2, a3, nope, a5] = spec.rows
    expect(a1).toMatchObject({ tier: 10, srcRow: 2, unit: [56.7, 45], min: 45, totals: [567, 450], optimal: 450, best: 'SKW', status: 'OK', quoted: '10 / 50', note: '' })
    expect(a2).toMatchObject({ tier: 5, srcRow: 4, unit: [100, null], min: 100, totals: [500, null], optimal: 500, best: 'HC', status: '1/2 quoted', quoted: '5' })
    expect(a3).toMatchObject({ tier: 2, srcRow: 5, unit: [null, null], min: null, totals: [null, null], optimal: null, best: '', status: 'No price (see Note)', note: 'HC: TDB' })
    expect(nope).toMatchObject({ tier: null, srcRow: 0, unit: [null, null], status: 'P/N not found', quoted: '-', rev: '', description: '' })
    expect(a5).toMatchObject({ tier: 1, unit: [7, 7], min: 7, best: 'TIE', status: 'OK', totals: [28, 28], optimal: 28 })
  })

  it('阶梯取档：不在档上取 ≤数量 的最大档，比最小档还小取最小档，总价按输入数量；数量未填 → Qty missing 但仍列出数量档', () => {
    const spec = buildNegoSheetSpec(master(), [
      { pn: 'A-1', qty: 20 },
      { pn: 'A-2', qty: 3 },
    ])
    expect(spec.rows[0]).toMatchObject({ tier: 10, unit: [56.7, 45], totals: [1134, 900], optimal: 900, status: 'OK' })
    expect(spec.rows[1]).toMatchObject({ tier: 5, unit: [100, null], totals: [300, null], status: '1/2 quoted' })
    const s60 = buildNegoSheetSpec(master(), [{ pn: 'A-1', qty: 60 }])
    expect(s60.rows[0]).toMatchObject({ tier: 50, srcRow: 3, unit: [40, 42], totals: [2400, 2520], best: 'HC', optimal: 2400 })
    const none = buildNegoSheetSpec(master(), [{ pn: 'A-1', qty: null }])
    expect(none.rows[0]).toMatchObject({ tier: null, srcRow: 0, unit: [null, null], status: 'Qty missing', quoted: '10 / 50', optimal: null })
  })

  it('列布局、公式文本与工作簿名称：结构化引用、按物理列引用汇总表、数组公式标记', () => {
    const spec = buildNegoSheetSpec(master(), [{ pn: 'A-1', qty: 10 }])
    const C = negoSheetColumns(spec.vendors)
    expect(C.names).toEqual(['P/N', 'Rev', 'Description', "Q'ty", 'HC Unit', 'SKW Unit', 'Min', 'HC Total', 'SKW Total', 'Optimal', 'Best', 'Status', 'Qty Tier', "Quoted Q'ty", 'Note', 'Src Row'])
    expect(C.count).toBe(16)
    const fx = negoFormulas(spec, 'NegoTable')
    expect(fx[C.pn]).toBeNull()
    expect(fx[C.qty]).toBeNull()
    expect(fx[C.rev]!.formula).toBe("IF(NegoTable[[#This Row],[Src Row]]=0,\"\",IF(INDEX('KK询价汇总'!$E:$E,NegoTable[[#This Row],[Src Row]])=\"\",\"\",INDEX('KK询价汇总'!$E:$E,NegoTable[[#This Row],[Src Row]])))")
    expect(fx[C.unitStart]!.formula).toContain("ISNUMBER(INDEX('KK询价汇总'!$J:$J,NegoTable[[#This Row],[Src Row]]))")
    expect(fx[C.unitStart + 1]!.formula).toContain("'KK询价汇总'!$K:$K")
    expect(fx[C.totalStart]!.formula).toBe("IF(OR(NegoTable[[#This Row],[HC Unit]]=\"\",NegoTable[[#This Row],[Q''ty]]=\"\"),\"\",NegoTable[[#This Row],[Q''ty]]*NegoTable[[#This Row],[HC Unit]])") // 结构化引用里 ' 翻倍
    expect(fx[C.min]!.formula).toBe('IF(COUNT(NegoTable[[#This Row],[HC Unit]:[SKW Unit]])=0,"",MIN(NegoTable[[#This Row],[HC Unit]:[SKW Unit]]))')
    expect(fx[C.best]!.formula).toContain('INDEX({"HC","SKW"},MATCH(')
    expect(fx[C.tier]).toMatchObject({ array: true })
    expect(fx[C.tier]!.formula).toContain("MAX((MPN=TRIM(NegoTable[[#This Row],[P/N]]))*(MQTY<=IFERROR(NegoTable[[#This Row],[Q''ty]]*1,0))*MQTY)")
    expect(fx[C.tier]!.formula).toContain('MIN(IF((MPN=TRIM(NegoTable[[#This Row],[P/N]]))*(MQTY>0),MQTY))')
    expect(fx[C.srcRow]!.formula).toBe('IF(NegoTable[[#This Row],[Qty Tier]]="",0,MAX((MPN=TRIM(NegoTable[[#This Row],[P/N]]))*(MQTY=NegoTable[[#This Row],[Qty Tier]])*MROW))')
    expect(fx[C.quoted]!.formula).toContain('_xlfn.TEXTJOIN(" / ",TRUE,_xlfn._xlws.SORT(_xlfn.UNIQUE(_xlfn._xlws.FILTER(MQTY,(MPN=')
    expect(fx[C.status]!.formula).toContain('COUNT(NegoTable[[#This Row],[HC Unit]:[SKW Unit]])&"/2 quoted"')
    expect(fx[C.note]!.formula).toContain('"HC: "&INDEX(\'KK询价汇总\'!$J:$J,')
    expect(negoDefinedNames(spec)).toEqual([
      { name: 'MPN', formula: "TRIM(SUBSTITUTE(SUBSTITUTE('KK询价汇总'!$D$2:$D$5000,CHAR(10),\" \"),CHAR(13),\" \"))" },
      { name: 'MQTY', formula: "IFERROR(VALUE('KK询价汇总'!$G$2:$G$5000),0)" },
      { name: 'MROW', formula: "ROW('KK询价汇总'!$D$2:$D$5000)" },
    ])
    // 只有一家时 UNITS 是单列引用
    const one = buildNegoSheetSpec(mkMaster([row({ 3: 'B-1', 6: 1, 9: 5 })]), [{ pn: 'B-1', qty: 1 }])
    expect(negoFormulas(one, 'T')[negoSheetColumns(one.vendors).min]!.formula).toBe('IF(COUNT(T[[#This Row],[HC Unit]])=0,"",MIN(T[[#This Row],[HC Unit]]))')
  })

  it('表格 XML 与 sheetData：ref 覆盖预填行 + 空行，计算列公式，预填行带缓存值，合计区公式', () => {
    const spec = buildNegoSheetSpec(master(), [{ pn: 'A-1', qty: 10 }, { pn: 'NOPE', qty: 3 }], { spareRows: 3 })
    const t = negoTableXml(spec, { id: 7, name: 'NegoTable' })
    expect(t).toContain('id="7" name="NegoTable" displayName="NegoTable" ref="A4:P9"') // 2 行 + 3 空行 → 第 9 行
    expect(t).toContain('<autoFilter ref="A4:P9"/>')
    expect(t).toContain('<tableColumns count="16">')
    expect((t.match(/<calculatedColumnFormula/g) ?? []).length).toBe(14)
    expect((t.match(/<calculatedColumnFormula array="1">/g) ?? []).length).toBe(5)
    expect(t).toContain('<tableColumn id="4" name="Q\'ty"/>')
    const d = negoSheetDataXml(spec, 'NegoTable')
    expect(d).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">Basis For Negotiation</t></is></c>')
    expect(d).toContain('<c r="H1" t="inlineStr"><is><t xml:space="preserve">HC</t></is></c>')
    expect(d).toContain('<c r="H2"><f>SUM(NegoTable[HC Total])</f><v>567</v></c>')
    expect(d).toContain('<c r="J3"><f>SUMIFS(NegoTable[Optimal],NegoTable[Status],&quot;OK&quot;)</f><v>450</v></c>')
    expect(d).toContain('<c r="A5" t="inlineStr"><is><t xml:space="preserve">A-1</t></is></c>')
    expect(d).toContain('<c r="D5"><v>10</v></c>')
    expect(d).toMatch(/<c r="E5"><f>IF\(NegoTable\[\[#This Row\],\[Src Row\]\]=0,[^<]*<\/f><v>56.7<\/v><\/c>/)
    expect(d).toMatch(/<c r="L5" t="str"><f t="array" ref="L5">[^<]*<\/f><v>OK<\/v><\/c>/)
    expect(d).toMatch(/<c r="P5"><f t="array" ref="P5">[^<]*<\/f><v>2<\/v><\/c>/) // Src Row = Excel 第 2 行
    expect(d).toMatch(/<c r="L6" t="str"><f t="array" ref="L6">[^<]*<\/f><v>P\/N not found<\/v><\/c>/)
    expect(d).not.toMatch(/<c r="A7"/) // 空行不写零件号
    expect(d).toMatch(/<c r="P7"><f t="array" ref="P7">[^<]*<\/f><v>0<\/v><\/c>/) // 空行 Src Row 缓存 0
    expect(d).toContain('<row r="9">')
    expect(d).not.toContain('<row r="10">')
  })
})
