import { useEffect, useMemo, useState } from 'react'
import { buildNegoLine, buildNegoSummary, negoToTsv, pnTiers } from '@engine/index'
import type { PnTier } from '@engine/index'
import { useSession } from '../store/session'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 无剪贴板权限时退回旧接口
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

const fmt = (n: number | null): string => (n === null ? '—' : String(n))

/** NEGO 比价面板：选中行/按 P/N 提取的零件并排比单价、按下单数量算各家总额与最优组合 */
export default function NegoPanel() {
  const open = useSession((s) => s.negoOpen)
  const master = useSession((s) => s.master)
  const negoLines = useSession((s) => s.negoLines)
  const closeNego = useSession((s) => s.closeNego)
  const addNegoLine = useSession((s) => s.addNegoLine)
  const setNegoQty = useSession((s) => s.setNegoQty)
  const removeNegoLine = useSession((s) => s.removeNegoLine)
  const showToast = useSession((s) => s.showToast)

  const [pnInput, setPnInput] = useState('')
  /** null = 尚未查询 */
  const [tiers, setTiers] = useState<{ pn: string; list: PnTier[] } | null>(null)

  useEffect(() => {
    if (open) {
      setPnInput('')
      setTiers(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNego()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeNego])

  const summary = useMemo(() => {
    if (!master) return null
    return buildNegoSummary(negoLines.map((l) => buildNegoLine(master, l.rowIndex, l.qty)))
  }, [master, negoLines])

  if (!open || !master || !summary) return null

  const search = () => {
    const pn = pnInput.trim()
    if (!pn) return
    setTiers({ pn, list: pnTiers(master, pn) })
  }

  const addTier = (tier: PnTier) => {
    if (negoLines.some((l) => l.rowIndex === tier.rowIndex)) {
      showToast({ message: '该行已在比价面板中' })
      return
    }
    addNegoLine(tier.rowIndex, tier.qty)
  }

  const onCopy = async () => {
    const ok = await copyText(negoToTsv(summary))
    showToast(
      ok
        ? { message: '已复制为表格，可直接粘贴进 Excel 的 NEGO sheet' }
        : { message: '复制失败，请手动选择内容复制' },
    )
  }

  const baseColCount = 4 // P/N Rev 描述 数量
  const vendors = summary.vendors

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div
        data-testid="nego-panel"
        className="flex max-h-[92vh] w-[min(96vw,1150px)] flex-col rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-bold">NEGO 比价</h2>
          <span className="text-xs text-slate-400">
            {summary.lines.length} 个零件 · 数量可改，总价按下单数量计算
          </span>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="nego-copy-btn"
            onClick={() => void onCopy()}
            disabled={summary.lines.length === 0}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            复制为表格
          </button>
          <button
            type="button"
            data-testid="nego-close-btn"
            onClick={closeNego}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            关闭 Esc
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-2.5">
          <span className="text-xs text-slate-500">按 P/N 添加：</span>
          <input
            data-testid="nego-pn-input"
            value={pnInput}
            onChange={(e) => setPnInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search()
            }}
            placeholder="输入零件编号后回车…"
            className="w-52 rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={search}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            查询
          </button>
          {tiers &&
            (tiers.list.length === 0 ? (
              <span className="text-xs text-amber-600">
                总表中未找到 <span className="font-mono">{tiers.pn}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-slate-600">
                数量档：
                {tiers.list.map((tier, i) => (
                  <span key={tier.rowIndex} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-slate-300">/</span>}
                    <button
                      type="button"
                      data-testid="nego-tier-chip"
                      onClick={() => addTier(tier)}
                      title={`第 ${tier.excelRow} 行 · ${tier.batch || '无批次'} · 点击加入比价`}
                      className="rounded-full bg-blue-50 px-2.5 py-0.5 font-medium text-blue-700 hover:bg-blue-100"
                    >
                      {tier.qty ?? '?'}
                    </button>
                  </span>
                ))}
                <span className="text-slate-400">（点击加入）</span>
              </span>
            ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10">
              <tr>
                {['P/N', 'Rev', '描述', '数量'].map((h) => (
                  <th key={h} className="border-b-2 border-slate-300 bg-white px-2 py-1.5 text-left font-medium text-slate-600">
                    {h}
                  </th>
                ))}
                {vendors.map((v) => (
                  <th
                    key={`u${v.slot}`}
                    className="border-b-2 border-slate-300 bg-white px-2 py-1.5 text-right font-medium text-slate-600"
                  >
                    {v.label} 单价
                  </th>
                ))}
                <th className="border-b-2 border-slate-300 bg-white px-2 py-1.5 text-right font-medium text-green-700">
                  最低单价
                </th>
                {vendors.map((v) => (
                  <th
                    key={`t${v.slot}`}
                    className="border-b-2 border-slate-300 bg-slate-50 px-2 py-1.5 text-right font-medium text-slate-600"
                  >
                    {v.label} 总价
                  </th>
                ))}
                <th className="border-b-2 border-slate-300 bg-slate-50 px-2 py-1.5 text-right font-medium text-green-700">
                  最优总价
                </th>
                <th className="border-b-2 border-slate-300 bg-white" />
              </tr>
            </thead>
            <tbody>
              {summary.lines.map((l, i) => (
                <tr key={`${l.rowIndex}`} data-testid="nego-line" className="hover:bg-blue-50/40">
                  <td className="border-b border-slate-100 px-2 py-1 font-mono font-medium">{l.pn}</td>
                  <td className="border-b border-slate-100 px-2 py-1">{l.rev}</td>
                  <td className="max-w-60 overflow-hidden border-b border-slate-100 px-2 py-1 text-ellipsis whitespace-nowrap" title={l.description}>
                    {l.description}
                  </td>
                  <td className="border-b border-slate-100 px-1 py-1">
                    <input
                      data-testid="nego-qty"
                      value={l.qty ?? ''}
                      inputMode="decimal"
                      onChange={(e) => {
                        const raw = e.target.value.trim()
                        if (raw === '') return setNegoQty(i, null)
                        const n = Number(raw)
                        if (Number.isFinite(n)) setNegoQty(i, n)
                      }}
                      className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-right"
                    />
                  </td>
                  {vendors.map((v) => {
                    const u = l.unit[v.slot] ?? null
                    const isMin = u !== null && l.minUnit !== null && u === l.minUnit
                    return (
                      <td
                        key={`u${v.slot}`}
                        data-min={isMin ? '1' : undefined}
                        className={`border-b border-slate-100 px-2 py-1 text-right ${
                          isMin ? 'bg-green-100 font-semibold text-green-700' : ''
                        } ${u === null ? 'text-slate-300' : ''}`}
                      >
                        {fmt(u)}
                      </td>
                    )
                  })}
                  <td className="border-b border-slate-100 px-2 py-1 text-right font-semibold text-green-700">
                    {fmt(l.minUnit)}
                  </td>
                  {vendors.map((v) => (
                    <td key={`t${v.slot}`} className="border-b border-slate-100 bg-slate-50/60 px-2 py-1 text-right">
                      {fmt(l.totals[v.slot] ?? null)}
                    </td>
                  ))}
                  <td className="border-b border-slate-100 bg-slate-50/60 px-2 py-1 text-right font-semibold text-green-700">
                    {fmt(l.optimalTotal)}
                  </td>
                  <td className="border-b border-slate-100 px-1 py-1 text-center">
                    <button
                      type="button"
                      data-testid="nego-remove"
                      onClick={() => removeNegoLine(i)}
                      title="移除本行"
                      className="rounded px-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {summary.lines.length === 0 && (
                <tr>
                  <td colSpan={baseColCount + vendors.length * 2 + 3} className="px-2 py-10 text-center text-slate-400">
                    还没有零件——在汇总表点 A 列选行后按 Ctrl+B，或在上方输入 P/N 回车添加
                  </td>
                </tr>
              )}
            </tbody>
            {summary.lines.length > 0 && (
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={baseColCount + vendors.length} className="border-t-2 border-slate-300 px-2 py-1.5 text-right">
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

        <div className="border-t border-slate-100 px-5 py-2 text-[11px] text-slate-400">
          各家总价 = 该家单价 × 下单数量；最优总价 = 每行取最低单价 ·
          绿色 = 本行最低 · 「复制为表格」后可直接粘贴进 Excel
        </div>
      </div>
    </div>
  )
}
