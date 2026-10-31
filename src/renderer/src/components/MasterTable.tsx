import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { KK_COL, KK_VENDOR_COLS, colLetter, isKkVendorCol } from '@engine/index'
import type { MasterRow } from '@engine/index'
import { api } from '../api'
import { useSession } from '../store/session'
import {
  ROW_H,
  columnWidths,
  rowWindow,
  stickyLefts,
  type ColumnSpec,
  type MeasureText,
  type RowWindow,
} from './tableLayout'

/** 34 列的紧凑中文表头（Excel 列字母另行小字显示） */
const COL_LABELS = [
  'No.', '批次', 'Item', 'P/N', 'Rev', '描述', '数量', '平均价',
  'Mao', 'HC', 'SKW', 'CL', 'BY', 'JM', 'US$', 'USD',
  'Cleaning', '材料费', '运费+税', 'Cost', '对客价', '报价单号', '交期',
  '材料', '表面处理', '清洗', '工艺', '尺寸', 'Type', '备注', '备注2', 'Base P/N', 'YJ', 'Base ID',
]

/** 每列最窄的宽度；内容更长时最多放宽到 1.6 倍，再长省略号截断 */
const COL_WIDTHS = [
  44, 128, 44, 118, 46, 220, 52, 76, 72, 72, 72, 72, 64, 64, 72, 60,
  62, 66, 70, 60, 68, 108, 150, 110, 130, 82, 82, 92, 60, 170, 80, 92, 64, 72,
]

/** 冻结列（A–D） */
const STICKY_COUNT = 4

const VENDOR_SLOTS = KK_VENDOR_COLS.map((v) => v.col)

/** 选区蓝色叠加用 inset 阴影实现，避免和最低价绿底/TDB 琥珀底的 bg 类冲突 */
const SEL_TINT = 'shadow-[inset_0_0_0_999px_rgba(59,130,246,0.16)]'

/** 没选列时统一用这一个空集合：每次拖选都会新建空 Set，换成同一个才不会让每一行都重画 */
const NO_COLS: ReadonlySet<number> = new Set()

/** 本行落在哪几块格区里，写成 "c1-c2,c1-c2"（不在任何一块里为 ''）：字符串传给行，内容不变时行不重画 */
function rowSpansKey(ranges: readonly CellRange[], v: number): string {
  let key = ''
  for (const r of ranges) {
    if (v < r.v1 || v > r.v2) continue
    key += `${key ? ',' : ''}${r.c1}-${r.c2}`
  }
  return key
}

function parseSpans(key: string): [number, number][] {
  if (!key) return []
  return key.split(',').map((part) => {
    const [a, b] = part.split('-')
    return [Number(a), Number(b)]
  })
}

function parsePriceNum(v: string | number | null): number | null {
  if (v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const cleaned = String(v).replace(/[￥¥$€,，\s ]/g, '')
  if (cleaned === '' || /tdb|tbd|待定/i.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function cellText(v: string | number | null): string {
  if (v === null) return ''
  return String(v)
}

/** 内容没变就沿用上一次的数组：列宽每次改格都重算，引用一变每一行都要重画 */
function useSameNumbers(next: readonly number[]): readonly number[] {
  const ref = useRef(next)
  const prev = ref.current
  if (prev !== next && (prev.length !== next.length || prev.some((v, i) => v !== next[i]))) ref.current = next
  return ref.current
}

/** 用 canvas 量文字宽度（和表格同字体）；量不了时按字数估 */
function createMeasurer(): { measure: MeasureText; header: (c: number) => number } {
  const doc = typeof document !== 'undefined' ? document : null
  const sans = (doc && getComputedStyle(doc.body).fontFamily) || 'system-ui, sans-serif'
  const mono =
    (doc && getComputedStyle(doc.documentElement).getPropertyValue('--font-mono').trim()) || 'ui-monospace, monospace'
  const ctx = (font: string) => {
    const c = doc?.createElement('canvas').getContext('2d') ?? null
    if (c) c.font = font
    return c
  }
  const body = ctx(`12px ${sans}`)
  const pn = ctx(`500 12px ${mono}`) // P/N 列是等宽字、加粗一档
  const label = ctx(`500 12px ${sans}`)
  const letter = ctx(`10px ${sans}`)
  const width = (c: CanvasRenderingContext2D | null, text: string, perChar: number) =>
    c ? c.measureText(text).width : text.length * perChar
  // 同样的字只量一次（批次名、材料、交期这些大量重复）
  const seen = [new Map<string, number>(), new Map<string, number>()]
  const cached = (font: 0 | 1, text: string) => {
    const map = seen[font]!
    let w = map.get(text)
    if (w === undefined) {
      if (map.size > 50_000) map.clear()
      w = width(font === 1 ? pn : body, text, 7.5)
      map.set(text, w)
    }
    return w
  }
  return {
    measure: (text, col) => cached(col === KK_COL.pn ? 1 : 0, text),
    // 表头：小字列字母 + 4px 间距 + 列名，左右内边距和右边框同数据格
    header: (c) => width(letter, colLetter(c), 6.5) + 4 + width(label, COL_LABELS[c]!, 12) + 14,
  }
}

function CellEditor(props: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(props.initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const latest = useRef({ value, initial: props.initial, onDone: props.onDone })
  latest.current = { value, initial: props.initial, onDone: props.onDone }

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // 编辑中把这一行滚出屏幕（只画看得见的行，编辑框会被拿掉）：改过的内容照样保存，不丢
  useEffect(
    () => () => {
      const l = latest.current
      if (done.current || l.value === l.initial) return
      done.current = true
      l.onDone(l.value)
    },
    [],
  )

  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    props.onDone(save ? value : null)
  }

  return (
    <input
      ref={ref}
      data-testid="cell-editor"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') {
          e.preventDefault() // 只取消编辑，不连带取消表里的选中
          finish(false)
        }
      }}
      className="block h-5 w-full border-2 border-blue-500 bg-white px-1 py-0 text-xs leading-4 select-text outline-none"
    />
  )
}

interface RowProps {
  row: MasterRow
  rowIndex: number
  editingCol: number | null
  selected: boolean
  selectedCols: ReadonlySet<number>
  /** 本行落在哪几块拖选格区里（见 rowSpansKey） */
  rangeSpans: string
  hiddenCols: ReadonlySet<number>
  stickyLeft: readonly number[]
  onFinishEdit: (rowIndex: number, col: number, value: string | null) => void
}

const MasterRowView = memo(function MasterRowView({
  row,
  rowIndex,
  editingCol,
  selected,
  selectedCols,
  rangeSpans,
  hiddenCols,
  stickyLeft,
  onFinishEdit,
}: RowProps) {
  const spans = parseSpans(rangeSpans)
  // 供应商列最低价高亮（≥2 家有数值才标）
  const prices = VENDOR_SLOTS.map((c) => parsePriceNum(row.cells[c] ?? null))
  const valid = prices.filter((p): p is number => p !== null)
  const min = valid.length >= 2 ? Math.min(...valid) : null

  return (
    <tr
      data-testid="master-row"
      style={{ height: ROW_H }}
      className={`group ${selected ? 'bg-blue-100/70' : 'hover:bg-blue-50/40'}`}
    >
      {row.cells.map((v, c) => {
        if (hiddenCols.has(c)) return null
        const isSticky = c < STICKY_COUNT
        const isVendor = isKkVendorCol(c)
        const num = isVendor ? parsePriceNum(v) : null
        const isMin = min !== null && num !== null && num === min
        const isTdb = isVendor && typeof v === 'string' && /tdb|tbd|待定/i.test(v)
        const isEditing = editingCol === c
        const tinted = spans.some(([a, b]) => c >= a && c <= b) || selectedCols.has(c)
        return (
          <td
            key={c}
            data-cell={`${rowIndex}:${c}`}
            title={c === 0 ? '点击选中本行；按住拖动可多选（用于比价/复制/删除）' : cellText(v)}
            style={isSticky ? { position: 'sticky', left: stickyLeft[c], zIndex: 1 } : undefined}
            className={`overflow-hidden border-r border-b border-slate-100 text-xs text-ellipsis whitespace-nowrap ${
              isEditing ? 'p-0' : 'px-1.5 py-0.5' // 编辑框正好占满一行高，行不变高
            } ${
              c === 0
                ? `cursor-pointer text-center select-none ${
                    selected ? 'bg-blue-500 font-bold text-white' : 'bg-slate-50 text-slate-400 hover:bg-blue-100'
                  }`
                : 'cursor-cell'
            } ${
              isSticky && c !== 0
                ? selected
                  ? 'bg-blue-50'
                  : 'bg-white group-hover:bg-blue-50'
                : ''
            } ${c === KK_COL.pn ? 'font-mono font-medium' : ''} ${
              isMin ? 'bg-green-100 font-semibold text-green-700' : ''
            } ${isTdb ? 'bg-amber-50 text-amber-700' : ''} ${
              c === KK_COL.quoteEach ? 'bg-blue-50/60 font-medium' : ''
            } ${tinted ? SEL_TINT : ''}`}
          >
            {isEditing ? (
              <CellEditor initial={cellText(v)} onDone={(value) => onFinishEdit(rowIndex, c, value)} />
            ) : c === 0 && selected ? (
              '✓'
            ) : (
              cellText(v)
            )}
          </td>
        )
      })}
    </tr>
  )
})

export interface CellRange {
  /** 可见行序区间（含端点） */
  v1: number
  v2: number
  c1: number
  c2: number
}

export default function MasterTable(props: {
  rows: { row: MasterRow; index: number }[]
  hasMaster: boolean
  /** 只读账号：单击格子不进入编辑 */
  readOnly: boolean
  /** 不显示的列（只读账号隐藏 O、P、Q、S） */
  hiddenCols: ReadonlySet<number>
  selected: Set<number>
  selectedCols: Set<number>
  /** 拖选的格区（可以好几块） */
  ranges: readonly CellRange[]
  onToggleRow: (rowIndex: number) => void
  /** A 列按住拖动：按可见序号区间选行，加在按下时已选的行（base）上 */
  onRowDrag: (vFrom: number, vTo: number, base: ReadonlySet<number>) => void
  onToggleCol: (col: number) => void
  /** 表头按住拖动：选 c1..c2 列，加在按下时已选的列（base）上 */
  onColDrag: (c1: number, c2: number, base: ReadonlySet<number>) => void
  /** 数据格按住拖动：框出一块格区，加在按下时已框的几块（base）后面 */
  onRangeDrag: (range: CellRange, base: readonly CellRange[]) => void
  onClearSelection: () => void
}) {
  const editMasterCell = useSession((s) => s.editMasterCell)
  const allRows = useSession((s) => s.master?.rows)
  const [editing, setEditing] = useState<{ rowIndex: number; col: number } | null>(null)

  // 引用不变：每一行都拿到它，变了就会让 2000 多行全部重画
  const finishEdit = useCallback(
    (rowIndex: number, col: number, value: string | null) => {
      setEditing(null)
      if (value !== null) editMasterCell(rowIndex, col, value)
    },
    [editMasterCell],
  )

  // 列宽：按整张总表的内容算一次（筛选、滚动都不变）；改一格只重量那一行
  const measurer = useMemo(() => createMeasurer(), [])
  const widthCache = useRef(new WeakMap<MasterRow, Float32Array>())
  const specs = useMemo<ColumnSpec[]>(
    () => COL_WIDTHS.map((min, c) => ({ min, max: min * 1.6, header: measurer.header(c) })),
    [measurer],
  )
  const widths = useSameNumbers(
    useMemo(() => columnWidths(allRows ?? [], specs, measurer.measure, widthCache.current), [allRows, specs, measurer]),
  )
  const stickyLeft = useMemo(() => stickyLefts(widths, STICKY_COUNT), [widths])
  const shownCols = useMemo(
    () => COL_LABELS.map((_, c) => c).filter((c) => !props.hiddenCols.has(c)),
    [props.hiddenCols],
  )
  const tableWidth = shownCols.reduce((sum, c) => sum + widths[c]!, 0)

  // 只画看得见的行（上下各多画一些），其余用等高空行占位
  const total = props.rows.length
  const scrollRef = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState<RowWindow>(() => rowWindow(0, 1200, ROW_H, Number.MAX_SAFE_INTEGER))
  const updateWindow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = rowWindow(el.scrollTop, el.clientHeight || window.innerHeight, ROW_H, total)
    setWin((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [total])
  useLayoutEffect(updateWindow, [updateWindow])
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateWindow)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateWindow])
  const start = Math.min(win.start, total)
  const end = Math.min(Math.max(win.end, start), total)

  // rawRowIndex → 可见位置（拖选按可见顺序换算）
  const posOf = useMemo(() => new Map(props.rows.map((r, i) => [r.index, i])), [props.rows])

  const drag = useRef<{
    kind: 'row' | 'col' | 'range'
    startV: number
    startC: number
    rawRow: number
    moved: boolean
    /** 上一次报出去的选区：鼠标在同一格里来回时不重复更新 */
    last: string
    /** 按下时已选的行/列：这次拖的加在它上面，不取消前面选的（Zane 2026-10-30） */
    base: ReadonlySet<number>
    /** 按下时已框的格区：框格区也一样接着加（Zane 2026-10-31） */
    baseRanges: readonly CellRange[]
  } | null>(null)

  const cellFromEvent = (e: React.MouseEvent): { rawRow: number; col: number; v: number } | null => {
    const td = (e.target as HTMLElement).closest?.('td[data-cell]')
    if (!td) return null
    const parts = (td as HTMLElement).dataset.cell!.split(':')
    const rawRow = Number(parts[0])
    const col = Number(parts[1])
    const v = posOf.get(rawRow)
    if (v === undefined) return null
    return { rawRow, col, v }
  }

  const colFromHeader = (e: React.MouseEvent): number | null => {
    const th = (e.target as HTMLElement).closest?.('th[data-colh]')
    if (!th) return null
    return Number((th as HTMLElement).dataset.colh)
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const hc = colFromHeader(e)
    if (hc !== null) {
      drag.current = {
        kind: 'col',
        startV: -1,
        startC: hc,
        rawRow: -1,
        moved: false,
        last: '',
        base: new Set(props.selectedCols),
        baseRanges: [],
      }
      e.preventDefault()
      return
    }
    const cell = cellFromEvent(e)
    if (!cell) return
    if (editing && editing.rowIndex === cell.rawRow && editing.col === cell.col) return // 编辑中的格子让 input 正常工作
    drag.current = {
      kind: cell.col === 0 ? 'row' : 'range',
      startV: cell.v,
      startC: cell.col,
      rawRow: cell.rawRow,
      moved: false,
      last: '',
      base: cell.col === 0 ? new Set(props.selected) : NO_COLS,
      baseRanges: cell.col === 0 ? [] : props.ranges,
    }
  }

  const onMouseOver = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    const report = (key: string, fn: () => void) => {
      if (key === d.last) return
      d.last = key
      fn()
    }
    if (d.kind === 'col') {
      const hc = colFromHeader(e)
      if (hc === null) return
      if (hc !== d.startC) d.moved = true
      const c1 = Math.min(d.startC, hc)
      const c2 = Math.max(d.startC, hc)
      if (d.moved) report(`${c1}:${c2}`, () => props.onColDrag(c1, c2, d.base))
      return
    }
    const cell = cellFromEvent(e)
    if (!cell) return
    if (d.kind === 'row') {
      if (cell.v !== d.startV) d.moved = true
      if (d.moved) report(String(cell.v), () => props.onRowDrag(d.startV, cell.v, d.base))
    } else {
      if (cell.v !== d.startV || cell.col !== d.startC) d.moved = true
      if (!d.moved) return
      const r: CellRange = {
        v1: Math.min(d.startV, cell.v),
        v2: Math.max(d.startV, cell.v),
        c1: Math.min(d.startC, Math.max(1, cell.col)),
        c2: Math.max(d.startC, Math.max(1, cell.col)),
      }
      report(`${r.v1}:${r.v2}:${r.c1}:${r.c2}`, () => props.onRangeDrag(r, d.baseRanges))
    }
  }

  const { onToggleRow, onToggleCol, readOnly } = props
  useEffect(() => {
    const onUp = () => {
      const d = drag.current
      drag.current = null
      if (!d || d.moved) return
      // 未拖动 = 单击：A 格切换选行；表头切换选列；数据格进入编辑（与旧版行为一致；只读账号不编辑）
      if (d.kind === 'col') onToggleCol(d.startC)
      else if (d.kind === 'row') onToggleRow(d.rawRow)
      else if (!readOnly) setEditing({ rowIndex: d.rawRow, col: d.startC })
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [onToggleRow, onToggleCol, readOnly])

  const selectedCols = props.selectedCols.size === 0 ? NO_COLS : props.selectedCols
  const ranges = props.ranges

  return (
    <div
      ref={scrollRef}
      onScroll={updateWindow}
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <table
        data-testid="master-table"
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        style={{ width: tableWidth }}
        className="table-fixed border-separate border-spacing-0 select-none"
      >
        <colgroup>
          {shownCols.map((c) => (
            <col key={c} style={{ width: widths[c] }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr>
            {shownCols.map((c) => (
              <th
                key={c}
                onClick={c === 0 ? props.onClearSelection : undefined}
                {...(c > 0 ? { 'data-colh': c } : {})}
                title={c === 0 ? '点击清空全部选中' : '点击选中整列，按住拖动选多列（Delete 清空 / Ctrl+C 复制）'}
                style={c < STICKY_COUNT ? { position: 'sticky', left: stickyLeft[c], zIndex: 11 } : undefined}
                className={`cursor-pointer border-r border-b border-slate-200 px-1.5 py-1.5 text-left text-xs font-medium whitespace-nowrap select-none ${
                  c > 0 && selectedCols.has(c)
                    ? 'bg-blue-200 text-blue-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <span className="mr-1 text-[10px] text-slate-400">{colLetter(c)}</span>
                {COL_LABELS[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr aria-hidden="true" style={{ height: start * ROW_H }}>
              <td colSpan={shownCols.length} />
            </tr>
          )}
          {props.rows.slice(start, end).map(({ row, index }, k) => {
            const i = start + k
            return (
              <MasterRowView
                key={index}
                row={row}
                rowIndex={index}
                editingCol={editing?.rowIndex === index ? editing.col : null}
                selected={props.selected.has(index)}
                selectedCols={selectedCols}
                rangeSpans={rowSpansKey(ranges, i)}
                hiddenCols={props.hiddenCols}
                stickyLeft={stickyLeft}
                onFinishEdit={finishEdit}
              />
            )
          })}
          {end < total && (
            <tr aria-hidden="true" style={{ height: (total - end) * ROW_H }}>
              <td colSpan={shownCols.length} />
            </tr>
          )}
          {props.rows.length === 0 && (
            <tr>
              <td colSpan={shownCols.length} className="px-4 py-24 text-center">
                <div className="text-4xl">📥</div>
                <div className="mt-3 text-base font-medium text-slate-600">
                  {props.hasMaster
                    ? '没有匹配的行'
                    : props.readOnly
                      ? '汇总表还没有导入'
                      : '把「KK 询价汇总表」拖到窗口任意位置载入历史数据；也可以直接拖入供应商报价（将新建汇总）'}
                </div>
                {!props.readOnly && (
                  <div className="mt-1.5 text-xs text-slate-400">
                    {api.server
                      ? '支持 .xlsx / .xlsm · 汇总表保存在 Mac 上的 pricompare 服务'
                      : '支持 .xlsx / .xlsm · 所有数据仅在本机处理，不会上传'}
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
