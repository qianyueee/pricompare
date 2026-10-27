import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildNegoSummary,
  buildNegoWorkbook,
  carryQtyFor,
  hiddenColsFor,
  masterRowsToTsv,
  minQtyFor,
  negoToTsv,
  resolveNegoInput,
  stepQtyTier,
} from '@engine/index'
import type { NegoSummaryLine, PnResolution } from '@engine/index'
import { api } from '../api'
import { todayBatch, useSession } from '../store/session'
import { copyText } from '../utils/clipboard'

const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : String(n))

const focusCell = (index: number, col: 'pn' | 'qty') => {
  const el = document.querySelector<HTMLInputElement>(`[data-ni="${index}:${col}"]`)
  el?.focus()
  el?.select()
}

/**
 * NEGO 比价页（全窗页面）：编号/数量两列像 Excel 一样直接输入或整列粘贴，
 * 编号填入后数量格以「1/3/6」灰字提示总表里的有效数量档，点进数量格时下方列出这些档可直接选；
 * 数量不填直接 Tab 取最小档；其余列按总表解析自动算。
 */
export default function NegoPage() {
  const open = useSession((s) => s.negoOpen)
  const master = useSession((s) => s.master)
  const negoLines = useSession((s) => s.negoLines)
  const closeNego = useSession((s) => s.closeNego)
  const clearNego = useSession((s) => s.clearNego)
  const setNegoPn = useSession((s) => s.setNegoPn)
  const commitNegoPn = useSession((s) => s.commitNegoPn)
  const setNegoQty = useSession((s) => s.setNegoQty)
  const removeNegoLine = useSession((s) => s.removeNegoLine)
  const pasteNego = useSession((s) => s.pasteNego)
  const showToast = useSession((s) => s.showToast)
  const exportMasterRows = useSession((s) => s.exportMasterRows)
  const exportingMaster = useSession((s) => s.exporting)
  const readOnly = useSession((s) => s.role !== 'editor')
  const [exportingNego, setExportingNego] = useState(false)
  /** 「复制为表格」「导出表格」两个下拉（都是比价表 / 总表格式），同时只开一个 */
  const [menu, setMenu] = useState<'copy' | 'export' | null>(null)
  const copyMenuRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  /** 数量 Tab 继承：最近一次明确输入/继承的数量，跳过没有该档的行后仍沿用 */
  const carryRef = useRef<number | null>(null)
  /** 这次数量格获得焦点是不是 Tab 跳过来的（鼠标点进来就重新开始，不沿用上次的继承数量） */
  const tabNavRef = useRef(false)
  /** 正在输入的数量格：下方（贴近底边时上方）列出该件在总表里的数量档 */
  const [qtyPop, setQtyPop] = useState<{ index: number; above: boolean } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const tabToQty = (index: number) => {
    tabNavRef.current = true
    requestAnimationFrame(() => {
      focusCell(index, 'qty')
      tabNavRef.current = false
    })
  }

  // 零件号输入提交（失焦/回车）：同零件号只保留先出现的一行
  const commitPn = (i: number): number => {
    const line = negoLines[i]
    if (!line || line.pn.trim() === '') return i
    const r = commitNegoPn(i)
    if (r.merged) showToast({ message: `零件号 ${line.pn.trim()} 已在第 ${r.index + 1} 行，已合并为一行` })
    return r.index
  }

  // 数量格 Tab：没填就取该件在总表里的最小数量档；然后跳到下一行数量格——
  // 下一行该件恰有继承的数量档则自动填入，否则留空（再 Tab 同样取最小档）
  const tabFromQty = (i: number, shift: boolean): boolean => {
    if (shift) {
      if (i === 0) return false
      tabToQty(i - 1)
      return true
    }
    const line = negoLines[i]
    const cur = line?.qty ?? null
    if (cur === null && line && master) {
      // 取的最小档不算手输的数量，不往下继承
      const min = minQtyFor(master, line.pn)
      if (min !== null) setNegoQty(i, min)
    }
    const next = negoLines[i + 1]
    if (!next) return false
    const carry = cur ?? carryRef.current
    carryRef.current = carry
    if (next.pn.trim() === '') {
      focusCell(i + 1, 'pn')
      return true
    }
    if (next.qty === null && master && carryQtyFor(master, next.pn, carry) !== null) setNegoQty(i + 1, carry)
    tabToQty(i + 1)
    return true
  }

  // 数量格选定一个数量档（点选或 ↑↓）：文字保持选中，接着打字就是改
  const pickQty = (i: number, qty: number) => {
    setNegoQty(i, qty)
    requestAnimationFrame(() => focusCell(i, 'qty'))
  }

  // 数量格 ↑/↓：在总表数量档之间切换（↑ 大一档、↓ 小一档）
  const stepQty = (i: number, dir: 1 | -1): boolean => {
    const line = negoLines[i]
    if (!line || !master) return false
    const q = stepQtyTier(master, line.pn, line.qty, dir)
    if (q === null) return false
    pickQty(i, q)
    return true
  }

  const onQtyFocus = (e: React.FocusEvent<HTMLInputElement>, i: number) => {
    if (!tabNavRef.current) carryRef.current = null
    const r = e.currentTarget.getBoundingClientRect()
    const box = scrollRef.current?.getBoundingClientRect()
    setQtyPop({ index: i, above: !!box && r.bottom + 72 > box.bottom })
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 汇总页也监听 Esc（取消选中）：这里先处理掉，返回汇总时选中的行保留
      e.preventDefault()
      if (menu) setMenu(null)
      else closeNego()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeNego, menu])

  // 下拉菜单点别处收起
  useEffect(() => {
    if (!menu) return
    const box = menu === 'copy' ? copyMenuRef : exportMenuRef
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  const view = useMemo(() => {
    const rows = negoLines.map((l) => {
      const res: PnResolution | null = master && l.pn.trim() !== '' ? resolveNegoInput(master, l.pn, l.qty) : null
      return { l, res }
    })
    const valid = rows.filter((r) => r.res?.line)
    const summary = buildNegoSummary(valid.map((r) => r.res!.line!))
    const sumById = new Map<number, NegoSummaryLine>()
    valid.forEach((r, i) => sumById.set(r.l.id, summary.lines[i]!))
    return { rows, summary, sumById, validCount: valid.length }
  }, [master, negoLines])

  if (!open) return null
  const { rows, summary, sumById } = view
  const vendors = summary.vendors

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, index: number, col: 'pn' | 'qty') => {
    const text = e.clipboardData.getData('text')
    if (!text || !/[\n\t]/.test(text.trim())) return // 单个值走默认输入
    e.preventDefault()
    const grid = text
      .replace(/\r/g, '')
      .split('\n')
      .filter((r) => r.trim() !== '')
      .map((r) => r.split('\t'))
    pasteNego(index, col, grid)
  }

  /** 每个零件在汇总表里取价的那一行（按比价页的顺序），「总表格式」复制和导出共用 */
  const pricedRowIdxs = (): number[] => [
    ...new Set(rows.flatMap(({ res }) => (res?.line && res.usedTier ? [res.usedTier.rowIndex] : []))),
  ]

  const onCopy = async () => {
    setMenu(null)
    const ok = await copyText(negoToTsv(summary))
    showToast(
      ok
        ? { message: '已复制为表格，可直接粘贴进 Excel 的 NEGO sheet' }
        : { message: '复制失败，请手动选择内容复制' },
    )
  }

  // 总表格式复制：汇总表整行、34 列位置不变（表格里不显示的 U 列对客价、只读账号的 O、P、Q、S 留空），直接贴进汇总表 Excel 列对得上
  const onCopyMasterFormat = async () => {
    setMenu(null)
    if (!master) return
    const picked = pricedRowIdxs().flatMap((i) => (master.rows[i] ? [master.rows[i]] : []))
    if (picked.length === 0) return
    const ok = await copyText(masterRowsToTsv(picked, hiddenColsFor(readOnly)))
    showToast(
      ok
        ? { message: `已复制 ${picked.length} 行（汇总表格式），可直接粘贴进汇总表` }
        : { message: '复制失败，请重试' },
    )
  }

  const onExport = async () => {
    setMenu(null)
    setExportingNego(true)
    try {
      const buffer = await buildNegoWorkbook(summary)
      const saved = await api.saveXlsx({ defaultFileName: `NEGO_${todayBatch()}.xlsx`, data: buffer })
      if (saved.saved) showToast({ message: '比价表已导出', path: saved.path })
    } catch (err) {
      showToast({ message: `导出失败：${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setExportingNego(false)
    }
  }

  // 总表格式：每个零件导出它取价的那一行（汇总表里的整行，按比价页的顺序）；
  // U 列 Quote (EA) 写成按 H 列 ÷6.7 × 清洗等级系数算美元报价的公式
  const onExportMasterFormat = () => {
    setMenu(null)
    void exportMasterRows(pricedRowIdxs(), `NEGO_${todayBatch()}_总表格式`, { quoteEaFormula: true })
  }

  const exportBusy = exportingNego || exportingMaster
  const colCount = 5 + vendors.length * 2 + 2 + 1

  return (
    <div data-testid="nego-page" className="fixed inset-0 z-40 flex flex-col bg-slate-50">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 shadow-sm">
        <button
          type="button"
          data-testid="nego-back-btn"
          onClick={closeNego}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          ← 返回汇总 <span className="ml-1 text-[10px] text-slate-400">Esc</span>
        </button>
        <h1 className="text-base font-bold">NEGO 比价</h1>
        <span className="text-xs text-slate-400">
          {view.validCount} 个零件 · 各家总价按下单数量计算
        </span>
        <div className="flex-1" />
        <div ref={copyMenuRef} className="relative">
          <button
            type="button"
            data-testid="nego-copy-btn"
            onClick={() => setMenu((m) => (m === 'copy' ? null : 'copy'))}
            disabled={view.validCount === 0}
            aria-haspopup="menu"
            aria-expanded={menu === 'copy'}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            复制为表格 <span className="ml-0.5 text-[10px]">▾</span>
          </button>
          {menu === 'copy' && (
            <div
              role="menu"
              data-testid="nego-copy-menu"
              className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-left shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="nego-copy-nego"
                onClick={() => void onCopy()}
                className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-medium text-slate-700">比价表</div>
                <div className="mt-0.5 text-[11px] text-slate-400">就是这页，带合计行，粘贴进 Excel 的 NEGO sheet</div>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="nego-copy-master"
                onClick={() => void onCopyMasterFormat()}
                className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-medium text-slate-700">总表格式</div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  这些零件在汇总表里取价的那一行，整行 34 列，直接粘贴进汇总表列对得上
                </div>
              </button>
            </div>
          )}
        </div>
        <div ref={exportMenuRef} className="relative">
          <button
            type="button"
            data-testid="nego-export-btn"
            onClick={() => setMenu((m) => (m === 'export' ? null : 'export'))}
            disabled={view.validCount === 0 || exportBusy}
            aria-haspopup="menu"
            aria-expanded={menu === 'export'}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {exportBusy ? '导出中…' : '导出表格'} <span className="ml-0.5 text-[10px]">▾</span>
          </button>
          {menu === 'export' && (
            <div
              role="menu"
              data-testid="nego-export-menu"
              className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-left shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="nego-export-nego"
                onClick={() => void onExport()}
                className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-medium text-slate-700">比价表</div>
                <div className="mt-0.5 text-[11px] text-slate-400">就是这页：各家单价、总价并排，带合计行</div>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="nego-export-master"
                onClick={onExportMasterFormat}
                className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="text-xs font-medium text-slate-700">总表格式</div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  这些零件在汇总表里取价的那一行，列和样式同「导出汇总表」
                </div>
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="nego-clear-btn"
          onClick={clearNego}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          清空
        </button>
      </div>

      <div className="border-b border-slate-100 bg-white px-4 py-1.5 text-[11px] text-slate-400">
        编号、数量两格可直接输入，也可从 Excel 整列复制粘贴（编号+数量两列一起粘也行）·
        编号填入后数量格灰字显示总表里的有效数量档「1/3/6」，点进数量格可直接点选或 ↑↓ 切换 ·
        数量不填直接 Tab 取最小档 · 数量不在档上时按 ≤数量 的最大档取单价 · Enter 跳到下一格
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
        <table className="w-full border-separate border-spacing-0 rounded-xl bg-white text-xs shadow-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="w-8 rounded-tl-xl border-b-2 border-slate-300 bg-white px-2 py-2 text-left font-medium text-slate-400">
                #
              </th>
              <th className="min-w-40 border-b-2 border-slate-300 bg-white px-2 py-2 text-left font-medium text-slate-600">
                P/N 编号
              </th>
              <th className="w-14 border-b-2 border-slate-300 bg-white px-2 py-2 text-left font-medium text-slate-600">
                Rev
              </th>
              <th className="min-w-44 border-b-2 border-slate-300 bg-white px-2 py-2 text-left font-medium text-slate-600">
                描述
              </th>
              <th className="w-24 border-b-2 border-slate-300 bg-white px-2 py-2 text-left font-medium text-slate-600">
                数量
              </th>
              {vendors.map((v) => (
                <th key={`u${v.slot}`} className="border-b-2 border-slate-300 bg-white px-2 py-2 text-right font-medium text-slate-600">
                  {v.label} 单价(¥)
                </th>
              ))}
              <th className="border-b-2 border-slate-300 bg-white px-2 py-2 text-right font-medium text-green-700">
                最低单价(¥)
              </th>
              {vendors.map((v) => (
                <th key={`t${v.slot}`} className="border-b-2 border-slate-300 bg-slate-50 px-2 py-2 text-right font-medium text-slate-600">
                  {v.label} 总价(¥)
                </th>
              ))}
              <th className="border-b-2 border-slate-300 bg-slate-50 px-2 py-2 text-right font-medium text-green-700">
                最优总价(¥)
              </th>
              <th className="w-8 rounded-tr-xl border-b-2 border-slate-300 bg-white" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ l, res }, i) => {
              const sl = sumById.get(l.id)
              const notFound = l.pn.trim() !== '' && res !== null && res.tiers.length === 0
              const tierHint =
                res && res.tiers.length > 0 && l.qty === null
                  ? res.tiers.map((t) => t.qty ?? '?').join('/')
                  : ''
              const tierMismatch =
                res?.usedTier && l.qty !== null && res.usedTier.qty !== null && res.usedTier.qty !== l.qty
              const showPop = qtyPop?.index === i && res !== null && res.tiers.length > 0
              const minQty = res?.tiers.find((t) => t.qty !== null)?.qty ?? null
              const typed = l.qty === null ? '' : String(l.qty)
              return (
                <tr key={l.id} data-testid="nego-line" className="group hover:bg-blue-50/30">
                  <td className="border-b border-slate-100 px-2 py-1 text-center text-slate-300">{i + 1}</td>
                  <td className="border-b border-slate-100 p-0.5">
                    <input
                      data-testid="nego-pn"
                      data-ni={`${i}:pn`}
                      value={l.pn}
                      onChange={(e) => setNegoPn(i, e.target.value)}
                      onPaste={(e) => onPaste(e, i, 'pn')}
                      onBlur={() => commitPn(i)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const kept = commitPn(i)
                          requestAnimationFrame(() => focusCell(kept, 'qty'))
                        }
                      }}
                      placeholder="输入或粘贴零件编号…"
                      className={`w-full rounded border px-1.5 py-1 font-mono ${
                        notFound ? 'border-red-300 bg-red-50 text-red-700' : 'border-transparent hover:border-slate-200 focus:border-blue-400'
                      } outline-none`}
                    />
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1">{res?.line?.rev ?? ''}</td>
                  <td
                    className={`max-w-64 overflow-hidden border-b border-slate-100 px-2 py-1 text-ellipsis whitespace-nowrap ${
                      notFound ? 'text-red-500' : ''
                    }`}
                    title={res?.line?.description}
                  >
                    {notFound ? '总表中未找到该编号' : (res?.line?.description ?? '')}
                  </td>
                  <td className="border-b border-slate-100 p-0.5">
                    <div className="relative flex items-center gap-1">
                      <input
                        data-testid="nego-qty"
                        data-ni={`${i}:qty`}
                        value={l.qty ?? ''}
                        inputMode="decimal"
                        onChange={(e) => {
                          const raw = e.target.value.trim()
                          if (raw === '') return setNegoQty(i, null)
                          const n = Number(raw)
                          if (Number.isFinite(n)) setNegoQty(i, n)
                        }}
                        onPaste={(e) => onPaste(e, i, 'qty')}
                        onFocus={(e) => onQtyFocus(e, i)}
                        onBlur={() => setQtyPop((p) => (p?.index === i ? null : p))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') focusCell(i + 1, 'pn')
                          else if (e.key === 'Tab' && tabFromQty(i, e.shiftKey)) e.preventDefault()
                          else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && stepQty(i, e.key === 'ArrowUp' ? 1 : -1))
                            e.preventDefault()
                        }}
                        placeholder={tierHint || undefined}
                        title={
                          tierHint ? `总表里的有效数量档：${tierHint}（输入其一或任意数量；不填直接 Tab 取最小 ${minQty ?? '档'}）` : undefined
                        }
                        className={`w-full rounded border px-1.5 py-1 text-right outline-none ${
                          tierHint
                            ? 'border-blue-200 bg-blue-50/50 placeholder:text-blue-500/80 placeholder:font-medium'
                            : 'border-transparent hover:border-slate-200 focus:border-blue-400'
                        }`}
                      />
                      {showPop && (
                        <div
                          data-testid="nego-qty-pop"
                          onMouseDown={(e) => e.preventDefault()} // 点选时数量格不失焦
                          className={`absolute left-0 z-20 w-max max-w-72 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left shadow-lg ${
                            qtyPop.above ? 'bottom-full mb-1' : 'top-full mt-1'
                          }`}
                        >
                          <div className="mb-1 text-[10px] whitespace-nowrap text-slate-400">
                            总表数量档
                            {l.qty === null && minQty !== null ? ` · 不填直接 Tab 取最小 ${minQty}` : ''} · ↑↓ 切换
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {res.tiers.map((t) => {
                              const used = res.usedTier?.rowIndex === t.rowIndex
                              const match = !used && typed !== '' && t.qty !== null && String(t.qty).startsWith(typed)
                              return (
                                <button
                                  key={t.rowIndex}
                                  type="button"
                                  data-testid="nego-qty-opt"
                                  data-used={used ? '1' : undefined}
                                  disabled={t.qty === null}
                                  onClick={() => t.qty !== null && pickQty(i, t.qty)}
                                  title={`汇总表第 ${t.excelRow} 行${t.batch ? ` · ${t.batch}` : ''}${t.qty === null ? ' · 数量为空' : ''}`}
                                  className={`min-w-8 rounded border px-1.5 py-0.5 text-xs font-medium ${
                                    used
                                      ? 'border-blue-600 bg-blue-600 text-white'
                                      : match
                                        ? 'border-blue-400 bg-blue-50 text-blue-700'
                                        : 'border-slate-200 text-slate-600 hover:border-blue-300 hover:bg-blue-50'
                                  } disabled:cursor-default disabled:text-slate-300 disabled:hover:border-slate-200 disabled:hover:bg-white`}
                                >
                                  {t.qty ?? '?'}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {tierMismatch && (
                        <span
                          data-testid="nego-tier-badge"
                          title={`总表无 ${l.qty} 数量档，单价取自 ${res!.usedTier!.qty} 档（第 ${res!.usedTier!.excelRow} 行）`}
                          className="rounded bg-amber-100 px-1 text-[10px] whitespace-nowrap text-amber-700"
                        >
                          取{res!.usedTier!.qty}档
                        </span>
                      )}
                    </div>
                  </td>
                  {vendors.map((v) => {
                    const u = res?.line?.unit[v.slot] ?? null
                    const isMin = u !== null && sl?.minUnit !== null && u === sl?.minUnit
                    return (
                      <td
                        key={`u${v.slot}`}
                        data-min={isMin ? '1' : undefined}
                        className={`border-b border-slate-100 px-2 py-1 text-right ${
                          isMin ? 'bg-green-100 font-semibold text-green-700' : ''
                        } ${u === null ? 'text-slate-300' : ''}`}
                      >
                        {res?.line ? fmt(u) : ''}
                      </td>
                    )
                  })}
                  <td className="border-b border-slate-100 px-2 py-1 text-right font-semibold text-green-700">
                    {sl ? fmt(sl.minUnit) : ''}
                  </td>
                  {vendors.map((v) => (
                    <td key={`t${v.slot}`} className="border-b border-slate-100 bg-slate-50/60 px-2 py-1 text-right">
                      {sl ? fmt(sl.totals[v.slot] ?? null) : ''}
                    </td>
                  ))}
                  <td className="border-b border-slate-100 bg-slate-50/60 px-2 py-1 text-right font-semibold text-green-700">
                    {sl ? fmt(sl.optimalTotal) : ''}
                  </td>
                  <td className="border-b border-slate-100 px-1 py-1 text-center">
                    {(l.pn.trim() !== '' || l.qty !== null) && (
                      <button
                        type="button"
                        data-testid="nego-remove"
                        onClick={() => removeNegoLine(i)}
                        title="移除本行"
                        className="rounded px-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {!master && (
              <tr>
                <td colSpan={colCount} className="px-2 py-8 text-center text-amber-600">
                  当前没有汇总表——请先返回汇总页载入 KK 询价汇总表，再回来比价
                </td>
              </tr>
            )}
          </tbody>
          {view.validCount > 0 && (
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={5 + vendors.length} className="border-t-2 border-slate-300 px-2 py-1.5 text-right">
                  合计
                </td>
                <td className="border-t-2 border-slate-300" />
                {summary.perVendor.map((v) => (
                  <td
                    key={v.slot}
                    data-testid={`nego-sum-${v.slot}`}
                    className="border-t-2 border-slate-300 bg-slate-100 px-2 py-1.5 text-right"
                    title={v.missing > 0 ? `${v.label} 有 ${v.missing} 行缺报价，合计仅含已报行` : undefined}
                  >
                    {v.sum}
                    {v.missing > 0 && <span className="ml-1 font-normal text-amber-600">（缺{v.missing}行）</span>}
                  </td>
                ))}
                <td
                  data-testid="nego-sum-optimal"
                  className="border-t-2 border-slate-300 bg-green-100 px-2 py-1.5 text-right text-green-700"
                >
                  {summary.optimalSum}
                </td>
                <td className="border-t-2 border-slate-300" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="border-t border-slate-100 bg-white px-4 py-1.5 text-[11px] text-slate-400">
        各家总价 = 该家单价 × 下单数量；最优总价 = 每行取最低单价 · 绿色 = 本行最低 ·
        「复制为表格」「导出表格」都可选比价表或总表格式（总表格式直接粘贴进汇总表列对得上）·
        汇总表选行后 Ctrl+B 也会把行带进来
      </div>
    </div>
  )
}
