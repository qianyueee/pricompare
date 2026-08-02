import { useMemo, useRef, useState } from 'react'
import { buildCompare } from '@engine/index'
import ExportBar from '../components/Compare/ExportBar'
import MatrixTable from '../components/Compare/MatrixTable'
import TotalsBar from '../components/Compare/TotalsBar'
import FileChip from '../components/FileChip'
import { collectVendorQuotes, useSession } from '../store/session'

export default function MainPage() {
  const files = useSession((s) => s.files)
  const usdRate = useSession((s) => s.usdRate)
  const addFiles = useSession((s) => s.addFiles)
  const importing = useSession((s) => s.importing)
  const inputRef = useRef<HTMLInputElement>(null)
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-bold">询价比价系统</h1>
        <button
          type="button"
          data-testid="add-files-btn"
          onClick={() => inputRef.current?.click()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
        >
          {importing ? '解析中…' : '＋ 添加报价'}
        </button>
        <input
          ref={inputRef}
          data-testid="file-input"
          type="file"
          multiple
          accept=".xlsx,.xlsm,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            if (files.length > 0) void addFiles(files)
            e.target.value = ''
          }}
        />
        {files.map((f) => (
          <FileChip key={f.id} file={f} />
        ))}
        <div className="flex-1" />
        <input
          data-testid="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 P/N 或描述…"
          className="w-52 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          只看可比行
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={onlySingle} onChange={(e) => setOnlySingle(e.target.checked)} />
          只看单家报价
        </label>
      </div>

      {result.warnings.length > 0 && (
        <ul className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {result.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {result.rows.length > 0 && <TotalsBar result={result} />}
      <MatrixTable result={result} rows={rows} />
      <ExportBar result={result} />
    </div>
  )
}
