import { useEffect, useRef, useState } from 'react'
import { useSession, type LoadedFile } from '../store/session'

const DOT: Record<string, string> = {
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
}

export default function FileChip({ file }: { file: LoadedFile }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const openMapping = useSession((s) => s.openMapping)
  const removeFile = useSession((s) => s.removeFile)
  const setSheet = useSession((s) => s.setSheet)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const tone =
    file.status === 'error' ? 'red' : file.confirmed ? (file.autoMapped ? 'blue' : 'green') : 'amber'
  const rowCount = file.analysis?.rows.length ?? 0
  const warnings = file.analysis?.warnings ?? []

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="file-chip"
        onClick={() => setOpen((v) => !v)}
        title={file.fileName}
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs shadow-sm hover:border-blue-300"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
        <span className="max-w-32 truncate font-medium">{file.vendorDisplay || file.fileName}</span>
        {file.status === 'ok' && <span className="text-slate-400">{rowCount}行</span>}
        {file.status === 'error' && <span className="text-red-500">失败</span>}
        {file.status === 'ok' && !file.confirmed && <span className="text-amber-600">待确认</span>}
        {file.confirmed && file.autoMapped && (
          <span data-testid="badge-auto" className="text-blue-500" title="已按保存的模板自动映射">
            自动
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1 w-80 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg">
          <div className="truncate font-medium text-slate-700" title={file.fileName}>
            {file.fileName}
          </div>
          {file.status === 'error' && <div className="mt-1 text-red-600">{file.error}</div>}
          {file.status === 'ok' && file.sheetNames.length > 1 && (
            <label className="mt-2 flex items-center gap-2 text-slate-500">
              工作表
              <select
                value={file.analysis?.sheetName}
                onChange={(e) => void setSheet(file.id, e.target.value)}
                className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
              >
                {file.sheetNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-amber-600">
              {warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            {file.status === 'ok' && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  openMapping(file.id)
                }}
                className="rounded-md bg-blue-50 px-2.5 py-1 text-blue-600 hover:bg-blue-100"
              >
                调整映射
              </button>
            )}
            <button
              type="button"
              onClick={() => removeFile(file.id)}
              className="rounded-md bg-slate-100 px-2.5 py-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
            >
              移除
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
