import { useMemo, useState } from 'react'
import { buildCompare } from '@engine/index'
import ExportBar from '../components/Compare/ExportBar'
import MatrixTable from '../components/Compare/MatrixTable'
import TotalsBar from '../components/Compare/TotalsBar'
import { collectVendorQuotes, useSession } from '../store/session'

export default function ComparePage() {
  const files = useSession((s) => s.files)
  const usdRate = useSession((s) => s.usdRate)
  const [search, setSearch] = useState('')
  const [onlyDiff, setOnlyDiff] = useState(false)
  const [onlySingle, setOnlySingle] = useState(false)

  const result = useMemo(() => buildCompare(collectVendorQuotes(files), usdRate), [files, usdRate])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return result.rows.filter((r) => {
      if (q && !r.pn.toLowerCase().includes(q) && !r.description.toLowerCase().includes(q)) return false
      if (onlyDiff && r.okCount < 2) return false
      if (onlySingle && !r.singleQuote) return false
      return true
    })
  }, [result, search, onlyDiff, onlySingle])

  if (result.vendors.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        请先在「导入报价」页拖入并确认至少一份报价文件
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <input
          data-testid="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 P/N 或描述…"
          className="w-64 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          只看可比行（≥2 家有效报价）
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={onlySingle} onChange={(e) => setOnlySingle(e.target.checked)} />
          只看单家报价
        </label>
        <div className="flex-1" />
        <div className="text-xs text-slate-400">
          共 {result.rows.length} 个比价行（零件 × 数量档位），显示 {rows.length} 行
        </div>
      </div>
      {result.warnings.length > 0 && (
        <ul className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {result.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      <TotalsBar result={result} />
      <MatrixTable result={result} rows={rows} />
      <ExportBar result={result} />
    </div>
  )
}
