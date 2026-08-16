import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDataRow } from '@engine/index'
import FileChip from '../components/FileChip'
import MasterTable from '../components/MasterTable'
import { useSession } from '../store/session'

export default function MainPage() {
  const files = useSession((s) => s.files)
  const master = useSession((s) => s.master)
  const masterDirty = useSession((s) => s.masterDirty)
  const importing = useSession((s) => s.importing)
  const exporting = useSession((s) => s.exporting)
  const addFiles = useSession((s) => s.addFiles)
  const exportMaster = useSession((s) => s.exportMaster)
  const openNego = useSession((s) => s.openNego)
  const inputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [batchFilter, setBatchFilter] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())

  const rows = master?.rows ?? []
  const dataCount = useMemo(() => rows.filter(isDataRow).length, [rows])

  // 汇总整表更换或行数变化（并入报价）时行号含义改变，清空选中
  const importedAt = master?.importedAt
  const rowCount = rows.length
  useEffect(() => {
    setSelected(new Set())
  }, [importedAt, rowCount])

  const toggleRow = useCallback((rowIndex: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowIndex)) next.delete(rowIndex)
      else next.add(rowIndex)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  // Ctrl/Cmd+B：带选中行进入 NEGO 比价面板（面板已开时忽略）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return
      const s = useSession.getState()
      if (s.negoOpen || !s.master) return
      e.preventDefault()
      openNego([...selected])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, openNego])

  const batches = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      const b = String(rows[i]!.cells[1] ?? '').trim()
      if (b && !seen.has(b)) {
        seen.add(b)
        out.push(b) // 最新批次在前
      }
    }
    return out
  }, [rows])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (!showEmpty && !isDataRow(row)) return false
        if (batchFilter && String(row.cells[1] ?? '').trim() !== batchFilter) return false
        if (q) {
          const hay =
            `${row.cells[3] ?? ''} ${row.cells[5] ?? ''} ${row.cells[1] ?? ''} ${row.cells[21] ?? ''}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
    // 显示时最新批次在最上（按批次块倒序，批次内部保持原顺序）；导出仍按原表顺序
    const data = filtered.filter((it) => isDataRow(it.row))
    const empty = filtered.filter((it) => !isDataRow(it.row))
    const blocks: { key: string; items: typeof data }[] = []
    for (const it of data) {
      const key = String(it.row.cells[1] ?? '').trim()
      const last = blocks[blocks.length - 1]
      if (last && last.key === key) last.items.push(it)
      else blocks.push({ key, items: [it] })
    }
    blocks.reverse()
    return [...blocks.flatMap((b) => b.items), ...empty]
  }, [rows, search, batchFilter, showEmpty])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-bold">询价汇总</h1>
        <button
          type="button"
          data-testid="add-files-btn"
          onClick={() => inputRef.current?.click()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
        >
          {importing ? '解析中…' : '＋ 导入（报价 / 汇总表）'}
        </button>
        <input
          ref={inputRef}
          data-testid="file-input"
          type="file"
          multiple
          accept=".xlsx,.xlsm,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const list = [...(e.target.files ?? [])]
            if (list.length > 0) void addFiles(list)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          data-testid="export-master-btn"
          disabled={!master || exporting}
          onClick={() => void exportMaster()}
          className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {exporting ? '导出中…' : '导出汇总表'}
          {masterDirty && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-300" title="有未导出的更改" />}
        </button>
        <button
          type="button"
          data-testid="nego-btn"
          disabled={!master}
          onClick={() => openNego([...selected])}
          title="选中若干行后进入 NEGO 比价（快捷键 Ctrl+B）；不选行则打开空面板按 P/N 添加"
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          比价 <span className="ml-1 rounded bg-indigo-500 px-1 py-0.5 text-[10px]">Ctrl+B</span>
        </button>
        {selected.size > 0 && (
          <span data-testid="selected-count" className="text-xs font-medium text-blue-600">
            已选 {selected.size} 行
          </span>
        )}
        {master && (
          <span className="text-xs text-slate-400">
            {master.sourceFileName ?? '新建汇总'} · {dataCount} 行数据 · {batches.length} 个批次
            {masterDirty && <span className="text-amber-600">（有未导出更改）</span>}
          </span>
        )}
        {files.map((f) => (
          <FileChip key={f.id} file={f} />
        ))}
        <div className="flex-1" />
        <select
          data-testid="batch-filter"
          value={batchFilter}
          onChange={(e) => setBatchFilter(e.target.value)}
          className="max-w-48 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
        >
          <option value="">全部批次</option>
          {batches.slice(0, 60).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <input
          data-testid="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 P/N / 描述 / 批次 / 单号…"
          className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          显示空行
        </label>
        <span className="text-xs text-slate-400">显示 {visible.length} 行</span>
      </div>
      <MasterTable
        rows={visible}
        hasMaster={master !== null}
        selected={selected}
        onToggleRow={toggleRow}
        onClearSelection={clearSelection}
      />
      <div className="text-[11px] text-slate-400">
        最新批次显示在最上（导出仍按原顺序）· 点击任意单元格可直接编辑（Enter 保存 / Esc 取消）·
        供应商列绿色 = 本行最低价 · 点 A 列选行，Ctrl+B 进入 NEGO 比价 ·
        拖入报价文件按规则并入汇总，拖入 KK 汇总表可整表更新
      </div>
    </div>
  )
}
