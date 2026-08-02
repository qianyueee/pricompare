import { useSession, type LoadedFile } from '../store/session'

function Badge(props: { tone: 'green' | 'amber' | 'blue' | 'red'; children: React.ReactNode; testid?: string }) {
  const tones = {
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-700',
    blue: 'bg-blue-100 text-blue-700',
    red: 'bg-red-100 text-red-700',
  }
  return (
    <span data-testid={props.testid} className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[props.tone]}`}>
      {props.children}
    </span>
  )
}

export default function FileCard({ file }: { file: LoadedFile }) {
  const openMapping = useSession((s) => s.openMapping)
  const removeFile = useSession((s) => s.removeFile)
  const setSheet = useSession((s) => s.setSheet)

  const rows = file.analysis?.rows ?? []
  const quoteNo = rows.find((r) => r.quoteNo)?.quoteNo

  return (
    <div data-testid="file-card" className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-800" title={file.fileName}>
            {file.fileName}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {file.status === 'error' ? (
              <Badge tone="red">解析失败</Badge>
            ) : file.confirmed && file.autoMapped ? (
              <Badge tone="blue" testid="badge-auto">已按保存的模板自动映射</Badge>
            ) : file.confirmed ? (
              <Badge tone="green">已就绪</Badge>
            ) : (
              <Badge tone="amber">待确认映射</Badge>
            )}
            {file.vendorDisplay && <span>供应商：{file.vendorDisplay}</span>}
            {quoteNo && <span>单号：{quoteNo}</span>}
            {file.status === 'ok' && <span>{rows.length} 行</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {file.status === 'ok' && (
            <button
              type="button"
              onClick={() => openMapping(file.id)}
              className="rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
            >
              调整映射
            </button>
          )}
          <button
            type="button"
            onClick={() => removeFile(file.id)}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
          >
            移除
          </button>
        </div>
      </div>
      {file.status === 'error' && <div className="text-xs text-red-600">{file.error}</div>}
      {file.status === 'ok' && file.sheetNames.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-slate-500">
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
      {file.status === 'ok' && (file.analysis?.warnings.length ?? 0) > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-600">
          {file.analysis!.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
