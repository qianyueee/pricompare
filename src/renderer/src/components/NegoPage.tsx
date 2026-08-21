import { useEffect, useMemo, useState } from 'react'
import { buildNegoSummary, buildNegoWorkbook, negoToTsv, resolveNegoInput } from '@engine/index'
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
 * 编号填入后数量格以「1/3/6」灰字提示总表里的有效数量档；其余列按总表解析自动算。
 */
export default function NegoPage() {
  const open = useSession((s) => s.negoOpen)
  const master = useSession((s) => s.master)
  const negoLines = useSession((s) => s.negoLines)
  const closeNego = useSession((s) => s.closeNego)
  const clearNego = useSession((s) => s.clearNego)
  const setNegoPn = useSession((s) => s.setNegoPn)
  const setNegoQty = useSession((s) => s.setNegoQty)
  const removeNegoLine = useSession((s) => s.removeNegoLine)
  const pasteNego = useSession((s) => s.pasteNego)
  const showToast = useSession((s) => s.showToast)
  const [exportingNego, setExportingNego] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNego()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeNego])

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

  const onCopy = async () => {
    const ok = await copyText(negoToTsv(summary))
    showToast(
      ok
        ? { message: '已复制为表格，可直接粘贴进 Excel 的 NEGO sheet' }
        : { message: '复制失败，请手动选择内容复制' },
    )
  }

  const onExport = async () => {
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
        <button
          type="button"
          data-testid="nego-copy-btn"
          onClick={() => void onCopy()}
          disabled={view.validCount === 0}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          复制为表格
        </button>
        <button
          type="button"
          data-testid="nego-export-btn"
          onClick={() => void onExport()}
          disabled={view.validCount === 0 || exportingNego}
          className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {exportingNego ? '导出中…' : '导出表格'}
        </button>
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
        编号填入后数量格灰字显示总表里的有效数量档「1/3/6」· 数量不在档上时按 ≤数量 的最大档取单价 ·
        Enter 跳到下一格
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') focusCell(i, 'qty')
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
                    <div className="flex items-center gap-1">
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
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') focusCell(i + 1, 'pn')
                        }}
                        placeholder={tierHint || undefined}
                        title={tierHint ? `总表里的有效数量档：${tierHint}（输入其一或任意数量）` : undefined}
                        className={`w-full rounded border px-1.5 py-1 text-right outline-none ${
                          tierHint
                            ? 'border-blue-200 bg-blue-50/50 placeholder:text-blue-500/80 placeholder:font-medium'
                            : 'border-transparent hover:border-slate-200 focus:border-blue-400'
                        }`}
                      />
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
        「复制为表格」后可直接粘贴进 Excel 的 NEGO sheet · 汇总表选行后 Ctrl+B 也会把行带进来
      </div>
    </div>
  )
}
