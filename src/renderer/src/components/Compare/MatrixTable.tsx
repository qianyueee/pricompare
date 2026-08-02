import { formatLeadTime } from '@engine/index'
import type { CompareResult, CompareRow } from '@engine/types'
import { fmtMoney, fmtPct } from '../../utils/format'

function PriceCell({ row, vendorId }: { row: CompareRow; vendorId: string }) {
  const cell = row.cells[vendorId]
  if (!cell || cell.price.status === 'empty') {
    return <td className="border-b border-slate-100 px-3 py-1.5 text-center text-slate-300">—</td>
  }
  if (cell.price.status === 'pending') {
    return (
      <td className="border-b border-slate-100 bg-amber-50 px-3 py-1.5 text-center">
        <span className="text-sm font-medium text-amber-700">待定</span>
        {cell.leadTime.raw && (
          <div className="text-[11px] text-slate-400">{formatLeadTime(cell.leadTime)}</div>
        )}
      </td>
    )
  }
  if (cell.price.status === 'invalid') {
    return (
      <td className="border-b border-slate-100 px-3 py-1.5 text-center">
        <span className="rounded bg-red-50 px-1 text-xs text-red-500" title={cell.price.raw}>
          无效
        </span>
      </td>
    )
  }
  return (
    <td
      className={`border-b border-slate-100 px-3 py-1.5 text-right ${
        cell.isMin ? 'bg-green-50' : ''
      }`}
    >
      <div className={`text-sm tabular-nums ${cell.isMin ? 'font-semibold text-green-700' : 'text-slate-700'}`}>
        {fmtMoney(cell.price.amount!, cell.price.currency)}
        {cell.price.currency === 'USD' && cell.rmbEquivalent !== null && (
          <span className="ml-1 text-[11px] text-slate-400">≈¥{cell.rmbEquivalent.toFixed(2)}</span>
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5 text-[11px]">
        {cell.deltaPct !== null && cell.deltaPct > 0 && (
          <span className="text-red-500">{fmtPct(cell.deltaPct)}</span>
        )}
        {cell.isMin && <span className="text-green-600">最低</span>}
        {cell.leadTime.raw && (
          <span className="text-slate-400" title="交期">
            {formatLeadTime(cell.leadTime)}
          </span>
        )}
      </div>
    </td>
  )
}

export default function MatrixTable({ result, rows }: { result: CompareResult; rows: CompareRow[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table data-testid="matrix" className="min-w-full border-collapse">
        <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500 shadow-sm">
          <tr>
            <th className="sticky left-0 z-20 border-b border-slate-200 bg-slate-50 px-3 py-2 text-left">P/N</th>
            <th className="border-b border-slate-200 px-2 py-2 text-left">Rev</th>
            <th className="border-b border-slate-200 px-2 py-2 text-right">数量</th>
            <th className="border-b border-slate-200 px-3 py-2 text-left">描述</th>
            {result.vendors.map((v) => (
              <th key={v.vendorId} className="border-b border-slate-200 px-3 py-2 text-right">
                {v.vendorDisplay}
              </th>
            ))}
            <th className="border-b border-slate-200 px-2 py-2">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid="matrix-row" className="hover:bg-slate-50/60">
              <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-3 py-1.5 font-mono text-sm text-slate-800">
                {row.pn}
              </td>
              <td className="border-b border-slate-100 px-2 py-1.5 text-xs text-slate-500">{row.rev || '—'}</td>
              <td className="border-b border-slate-100 px-2 py-1.5 text-right text-sm tabular-nums">
                {row.qty ?? '—'}
              </td>
              <td
                className="max-w-56 truncate border-b border-slate-100 px-3 py-1.5 text-xs text-slate-500"
                title={row.description}
              >
                {row.description}
              </td>
              {result.vendors.map((v) => (
                <PriceCell key={v.vendorId} row={row} vendorId={v.vendorId} />
              ))}
              <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                {row.singleQuote && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">仅一家</span>
                )}
              </td>
            </tr>
          ))}
          {result.vendors.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-24 text-center">
                <div className="text-4xl">📥</div>
                <div className="mt-3 text-base font-medium text-slate-600">
                  把供应商报价 Excel 拖到窗口任意位置，或点上方「＋ 添加报价」
                </div>
                <div className="mt-1.5 text-xs text-slate-400">
                  支持 .xlsx / .xlsm / .xls，可一次拖入多份 · 所有数据仅在本机处理，不会上传
                </div>
              </td>
            </tr>
          )}
          {result.vendors.length > 0 && rows.length === 0 && (
            <tr>
              <td colSpan={5 + result.vendors.length} className="px-4 py-10 text-center text-sm text-slate-400">
                没有匹配的比价行
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
