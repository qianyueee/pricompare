import type { CompareResult } from '@engine/types'
import { fmtNum } from '../../utils/format'

export default function TotalsBar({ result }: { result: CompareResult }) {
  if (result.rows.length === 0) return null
  const anyMissing = result.totals.perVendor.some((v) => v.missingRows > 0)
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {result.totals.perVendor.map((v) => {
        const display = result.vendors.find((x) => x.vendorId === v.vendorId)?.vendorDisplay ?? v.vendorId
        return (
          <div key={v.vendorId} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
            <div className="text-sm font-semibold text-slate-700">{display}</div>
            <div className="text-slate-500">
              报价 {v.quotedRows}/{result.rows.length} 行
              {v.missingRows > 0 && <span className="text-amber-600">（缺 {v.missingRows}）</span>}
            </div>
            <div className="mt-0.5 tabular-nums text-slate-600">金额合计 ¥{fmtNum(v.sumExtended)}</div>
          </div>
        )
      })}
      {result.totals.comparableRows > 0 && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs shadow-sm">
          <div className="text-sm font-semibold text-green-700">最优组合（每行取最低）</div>
          <div className="text-green-700/70">覆盖 {result.totals.comparableRows} 行</div>
          <div className="mt-0.5 tabular-nums font-medium text-green-700">
            金额合计 ¥{fmtNum(result.totals.bestExtendedSum)}
          </div>
        </div>
      )}
      {anyMissing && (
        <div className="self-center text-xs text-slate-400">各家覆盖行数不同时，合计仅供参考</div>
      )}
    </div>
  )
}
