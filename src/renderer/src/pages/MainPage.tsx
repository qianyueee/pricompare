import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDataRow } from '@engine/index'
import FileChip from '../components/FileChip'
import MasterTable, { type CellRange } from '../components/MasterTable'
import { useSession } from '../store/session'
import { copyText } from '../utils/clipboard'

const ALL_EDIT_COLS = Array.from({ length: 32 }, (_, i) => i + 1) // B..AG（A 列序号不参与清空）

export default function MainPage() {
  const files = useSession((s) => s.files)
  const master = useSession((s) => s.master)
  const masterDirty = useSession((s) => s.masterDirty)
  const importing = useSession((s) => s.importing)
  const exporting = useSession((s) => s.exporting)
  const addFiles = useSession((s) => s.addFiles)
  const exportMaster = useSession((s) => s.exportMaster)
  const openNego = useSession((s) => s.openNego)
  const deleteRowsAction = useSession((s) => s.deleteRows)
  const clearCellsAction = useSession((s) => s.clearCells)
  const undoMasterEdit = useSession((s) => s.undoMasterEdit)
  const undoSnapshot = useSession((s) => s.undoSnapshot)
  const showToast = useSession((s) => s.showToast)
  const inputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [batchFilter, setBatchFilter] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [selCols, setSelCols] = useState<Set<number>>(() => new Set())
  const [selRange, setSelRange] = useState<CellRange | null>(null)

  const rows = master?.rows ?? []
  const dataCount = useMemo(() => rows.filter(isDataRow).length, [rows])

  // 汇总整表更换或行数变化（并入/删行）时行号含义改变，清空全部选区
  const importedAt = master?.importedAt
  const rowCount = rows.length
  useEffect(() => {
    setSelected(new Set())
    setSelCols(new Set())
    setSelRange(null)
  }, [importedAt, rowCount])

  // 筛选/搜索改变可见顺序 → 格区（按可见位置记录）作废
  useEffect(() => {
    setSelRange(null)
  }, [search, batchFilter, showEmpty])

  // 三种选区互斥：行 / 列 / 格区
  const toggleRow = useCallback((rowIndex: number) => {
    setSelCols(new Set())
    setSelRange(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowIndex)) next.delete(rowIndex)
      else next.add(rowIndex)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelected(new Set())
    setSelCols(new Set())
    setSelRange(null)
  }, [])

  const toggleCol = useCallback((col: number) => {
    setSelected(new Set())
    setSelRange(null)
    setSelCols((prev) => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      return next
    })
  }, [])

  const colDrag = useCallback((c1: number, c2: number) => {
    setSelected(new Set())
    setSelRange(null)
    const next = new Set<number>()
    for (let c = Math.max(1, c1); c <= c2; c++) next.add(c)
    setSelCols(next)
  }, [])

  const rangeDrag = useCallback((r: CellRange) => {
    setSelected(new Set())
    setSelCols(new Set())
    setSelRange(r)
  }, [])

  // Ctrl/Cmd+B：带选中行进入 NEGO 比价页（页已开时忽略）
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

  // 事件回调里取最新可见序列（拖选/复制/清空都按显示顺序换算）
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const rowDrag = useCallback((vFrom: number, vTo: number) => {
    setSelCols(new Set())
    setSelRange(null)
    const [a, b] = vFrom <= vTo ? [vFrom, vTo] : [vTo, vFrom]
    setSelected(new Set(visibleRef.current.slice(a, b + 1).map((it) => it.index)))
  }, [])

  const selKind = selected.size > 0 ? 'rows' : selCols.size > 0 ? 'cols' : selRange ? 'range' : null

  const copySelection = useCallback(async () => {
    const vis = visibleRef.current
    let tsv = ''
    let desc = ''
    if (selected.size > 0) {
      const picked = vis.filter((it) => selected.has(it.index))
      tsv = picked.map((it) => it.row.cells.map((c) => c ?? '').join('\t')).join('\n')
      desc = `${picked.length} 行`
    } else if (selCols.size > 0) {
      const cols = [...selCols].sort((a, b) => a - b)
      tsv = vis.map((it) => cols.map((c) => it.row.cells[c] ?? '').join('\t')).join('\n')
      desc = `${cols.length} 列（${vis.length} 行）`
    } else if (selRange) {
      const lines: string[] = []
      for (let v = selRange.v1; v <= selRange.v2; v++) {
        const it = vis[v]
        if (!it) continue
        const cells: (string | number)[] = []
        for (let c = selRange.c1; c <= selRange.c2; c++) cells.push(it.row.cells[c] ?? '')
        lines.push(cells.join('\t'))
      }
      tsv = lines.join('\n')
      desc = `${selRange.v2 - selRange.v1 + 1}×${selRange.c2 - selRange.c1 + 1} 格`
    } else return
    const ok = await copyText(tsv)
    showToast({ message: ok ? `已复制 ${desc}，可直接粘贴进 Excel` : '复制失败，请重试' })
  }, [selected, selCols, selRange, showToast])

  const clearSelectionCells = useCallback(() => {
    const vis = visibleRef.current
    if (selected.size > 0) {
      clearCellsAction([...selected].map((rowIndex) => ({ rowIndex, cols: ALL_EDIT_COLS })))
    } else if (selCols.size > 0) {
      const cols = [...selCols]
      clearCellsAction(vis.map((it) => ({ rowIndex: it.index, cols })))
    } else if (selRange) {
      const cols: number[] = []
      for (let c = Math.max(1, selRange.c1); c <= selRange.c2; c++) cols.push(c)
      const targets: { rowIndex: number; cols: number[] }[] = []
      for (let v = selRange.v1; v <= selRange.v2; v++) {
        const it = vis[v]
        if (it) targets.push({ rowIndex: it.index, cols })
      }
      clearCellsAction(targets)
    }
  }, [selected, selCols, selRange, clearCellsAction])

  const deleteSelectedRows = useCallback(() => {
    if (selected.size > 0) deleteRowsAction([...selected])
  }, [selected, deleteRowsAction])

  // Ctrl+C 复制选区 / Delete 清空内容 / Ctrl+Z 撤销（输入框聚焦或比价页打开时不抢）
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement
      return (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      )
    }
    const onKey = (e: KeyboardEvent) => {
      if (useSession.getState().negoOpen || isTyping()) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        if (useSession.getState().undoSnapshot) {
          e.preventDefault()
          undoMasterEdit()
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'c') {
        if (selKind) {
          e.preventDefault()
          void copySelection()
        }
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && selKind) {
        e.preventDefault()
        clearSelectionCells()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selKind, copySelection, clearSelectionCells, undoMasterEdit])

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
        selectedCols={selCols}
        range={selRange}
        onToggleRow={toggleRow}
        onRowDrag={rowDrag}
        onToggleCol={toggleCol}
        onColDrag={colDrag}
        onRangeDrag={rangeDrag}
        onClearSelection={clearSelection}
      />
      <div className="text-[11px] text-slate-400">
        最新批次显示在最上（导出仍按原顺序）· 单击格子编辑（Enter 保存 / Esc 取消），按住拖动选多格 ·
        A 列选行、表头选列（都可拖选多个）→ Ctrl+C 复制 / Delete 清空 / 删除行按钮整行删除 / Ctrl+Z 撤销 ·
        供应商列绿色 = 本行最低价 · 选行后 Ctrl+B 进入 NEGO 比价 · 拖入报价按规则并入，拖入 KK 汇总表整表更新
      </div>
      {/* 选区操作条悬浮定位：出现/消失不推移表格（拖选中布局位移会让静止指针误触发 mouseover） */}
      {(selKind || undoSnapshot) && (
        <div className="fixed bottom-10 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1.5 pr-2 pl-3.5 shadow-xl">
          {selKind && (
            <>
              <span data-testid="selected-count" className="text-xs font-medium text-blue-600">
                {selKind === 'rows'
                  ? `已选 ${selected.size} 行`
                  : selKind === 'cols'
                    ? `已选 ${selCols.size} 列`
                    : `已选 ${selRange!.v2 - selRange!.v1 + 1}×${selRange!.c2 - selRange!.c1 + 1} 格`}
              </span>
              <button
                type="button"
                data-testid="copy-selection-btn"
                onClick={() => void copySelection()}
                title="复制所选为表格（Ctrl+C），可直接粘贴进 Excel"
                className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                复制
              </button>
              <button
                type="button"
                data-testid="clear-cells-btn"
                onClick={clearSelectionCells}
                title="清空所选内容（Delete）；A 列序号保留"
                className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                清空内容
              </button>
              {selKind === 'rows' && (
                <button
                  type="button"
                  data-testid="delete-rows-btn"
                  onClick={deleteSelectedRows}
                  title="整行删除（A 列序号自动重排；Ctrl+Z 可撤销）"
                  className="rounded-full border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  删除行
                </button>
              )}
              <button
                type="button"
                onClick={clearSelection}
                title="取消选择"
                className="rounded-full px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-100"
              >
                ✕
              </button>
            </>
          )}
          {undoSnapshot && (
            <button
              type="button"
              data-testid="undo-btn"
              onClick={undoMasterEdit}
              title={`撤销：${undoSnapshot.label}`}
              className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100"
            >
              撤销 Ctrl+Z
            </button>
          )}
        </div>
      )}
    </div>
  )
}
