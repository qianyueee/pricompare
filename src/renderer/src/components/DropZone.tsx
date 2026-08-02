import { useRef, useState } from 'react'
import { useSession } from '../store/session'

const ACCEPT_RE = /\.(xlsx|xlsm|xls|csv)$/i

export default function DropZone() {
  const addFiles = useSession((s) => s.addFiles)
  const importing = useSession((s) => s.importing)
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const take = (list: FileList | null | undefined) => {
    const files = [...(list ?? [])].filter((f) => ACCEPT_RE.test(f.name))
    if (files.length > 0) void addFiles(files)
  }

  return (
    <div
      data-testid="drop-zone"
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        take(e.dataTransfer?.files)
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
        over ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-white hover:border-blue-400 hover:bg-slate-50'
      }`}
    >
      <div className="text-4xl">📥</div>
      <div className="text-base font-medium text-slate-700">
        {importing ? '正在解析…' : '把供应商报价 Excel 拖到这里，或点击选择文件'}
      </div>
      <div className="text-xs text-slate-400">
        支持 .xlsx / .xlsm / .xls，可一次拖入多份 · 所有数据仅在本机处理，不会上传
      </div>
      <input
        ref={inputRef}
        data-testid="file-input"
        type="file"
        multiple
        accept=".xlsx,.xlsm,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
