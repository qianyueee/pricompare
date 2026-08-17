import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { KK_COL, colLetter } from '@engine/index'
import type { MasterRow } from '@engine/index'
import { useSession } from '../store/session'

/** 33 列的紧凑中文表头（Excel 列字母另行小字显示） */
const COL_LABELS = [
  'No.', '批次', 'Item', 'P/N', 'Rev', '描述', '数量', '选定价',
  'Mao', 'HC', 'SKW', 'BY', 'YJ', 'JM', 'US$', 'USD',
  'Cleaning', '材料费', '运费+税', 'Cost', '对客价', '报价单号', '交期',
  '材料', '表面处理', '清洗', '工艺', '尺寸', 'Type', '备注', '备注2', 'Base P/N', 'Base ID',
]

const COL_WIDTHS = [
  44, 128, 44, 118, 46, 220, 52, 76, 72, 72, 72, 64, 64, 64, 72, 60,
  62, 66, 70, 60, 68, 108, 150, 110, 130, 82, 82, 92, 60, 170, 80, 92, 72,
]

/** 冻结列（A–D）的累计左偏移 */
const STICKY_COUNT = 4
const STICKY_LEFT = [0, 44, 172, 216]

const VENDOR_SLOTS = [8, 9, 10, 11, 12, 13]

/** 选区蓝色叠加用 inset 阴影实现，避免和最低价绿底/TDB 琥珀底的 bg 类冲突 */
const SEL_TINT = 'shadow-[inset_0_0_0_999px_rgba(59,130,246,0.16)]'

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

function CellEditor(props: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(props.initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

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
        else if (e.key === 'Escape') finish(false)
      }}
      className="h-full w-full border-2 border-blue-500 bg-white px-1 py-0.5 text-xs select-text outline-none"
    />
  )
}

interface RowProps {
  row: MasterRow
  rowIndex: number
  editingCol: number | null
  selected: boolean
  selectedCols: Set<number>
  /** 本行落在拖选格区内时的列区间 [c1, c2]；不在格区内为 null */
  rangeCols: [number, number] | null
  onFinishEdit: (rowIndex: number, col: number, value: string | null) => void
}

const MasterRowView = memo(function MasterRowView({
  row,
  rowIndex,
  editingCol,
  selected,
  selectedCols,
  rangeCols,
  onFinishEdit,
}: RowProps) {
  // 供应商列最低价高亮（≥2 家有数值才标）
  const prices = VENDOR_SLOTS.map((c) => parsePriceNum(row.cells[c] ?? null))
  const valid = prices.filter((p): p is number => p !== null)
  const min = valid.length >= 2 ? Math.min(...valid) : null

  return (
    <tr
      data-testid="master-row"
      className={`group ${selected ? 'bg-blue-100/70' : 'hover:bg-blue-50/40'}`}
    >
      {row.cells.map((v, c) => {
        const isSticky = c < STICKY_COUNT
        const isVendor = c >= 8 && c <= 13
        const num = isVendor ? parsePriceNum(v) : null
        const isMin = min !== null && num !== null && num === min
        const isTdb = isVendor && typeof v === 'string' && /tdb|tbd|待定/i.test(v)
        const isEditing = editingCol === c
        const tinted =
          (rangeCols !== null && c >= rangeCols[0] && c <= rangeCols[1]) || selectedCols.has(c)
        return (
          <td
            key={c}
            data-cell={`${rowIndex}:${c}`}
            title={c === 0 ? '点击选中本行；按住拖动可多选（用于比价/复制/删除）' : cellText(v)}
            style={{
              minWidth: COL_WIDTHS[c],
              maxWidth: COL_WIDTHS[c]! * 1.6,
              ...(isSticky ? { position: 'sticky' as const, left: STICKY_LEFT[c], zIndex: 1 } : {}),
            }}
            className={`overflow-hidden border-r border-b border-slate-100 px-1.5 py-0.5 text-xs text-ellipsis whitespace-nowrap ${
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
            } ${tinted ? SEL_TINT : ''} ${isEditing ? 'p-0' : ''}`}
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
  selected: Set<number>
  selectedCols: Set<number>
  range: CellRange | null
  onToggleRow: (rowIndex: number) => void
  /** A 列按住拖动：按可见序号区间整选行 */
  onRowDrag: (vFrom: number, vTo: number) => void
  onToggleCol: (col: number) => void
  onColDrag: (c1: number, c2: number) => void
  onRangeDrag: (range: CellRange) => void
  onClearSelection: () => void
}) {
  const editMasterCell = useSession((s) => s.editMasterCell)
  const [editing, setEditing] = useState<{ rowIndex: number; col: number } | null>(null)

  const finishEdit = (rowIndex: number, col: number, value: string | null) => {
    setEditing(null)
    if (value !== null) editMasterCell(rowIndex, col, value)
  }

  // rawRowIndex → 可见位置（拖选按可见顺序换算）
  const posOf = useMemo(() => new Map(props.rows.map((r, i) => [r.index, i])), [props.rows])

  const drag = useRef<{
    kind: 'row' | 'col' | 'range'
    startV: number
    startC: number
    rawRow: number
    moved: boolean
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
      drag.current = { kind: 'col', startV: -1, startC: hc, rawRow: -1, moved: false }
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
    }
  }

  const onMouseOver = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'col') {
      const hc = colFromHeader(e)
      if (hc === null) return
      if (hc !== d.startC) d.moved = true
      if (d.moved) props.onColDrag(Math.min(d.startC, hc), Math.max(d.startC, hc))
      return
    }
    const cell = cellFromEvent(e)
    if (!cell) return
    if (d.kind === 'row') {
      if (cell.v !== d.startV) d.moved = true
      if (d.moved) props.onRowDrag(d.startV, cell.v)
    } else {
      if (cell.v !== d.startV || cell.col !== d.startC) d.moved = true
      if (d.moved)
        props.onRangeDrag({
          v1: Math.min(d.startV, cell.v),
          v2: Math.max(d.startV, cell.v),
          c1: Math.min(d.startC, Math.max(1, cell.col)),
          c2: Math.max(d.startC, Math.max(1, cell.col)),
        })
    }
  }

  const { onToggleRow, onToggleCol } = props
  useEffect(() => {
    const onUp = () => {
      const d = drag.current
      drag.current = null
      if (!d || d.moved) return
      // 未拖动 = 单击：A 格切换选行；表头切换选列；数据格进入编辑（与旧版行为一致）
      if (d.kind === 'col') onToggleCol(d.startC)
      else if (d.kind === 'row') onToggleRow(d.rawRow)
      else setEditing({ rowIndex: d.rawRow, col: d.startC })
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [onToggleRow, onToggleCol])

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table
        data-testid="master-table"
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        className="border-separate border-spacing-0 select-none"
      >
        <thead className="sticky top-0 z-10">
          <tr>
            {COL_LABELS.map((label, c) => (
              <th
                key={c}
                onClick={c === 0 ? props.onClearSelection : undefined}
                {...(c > 0 ? { 'data-colh': c } : {})}
                title={c === 0 ? '点击清空全部选中' : '点击选中整列，按住拖动选多列（Delete 清空 / Ctrl+C 复制）'}
                style={{
                  minWidth: COL_WIDTHS[c],
                  ...(c < STICKY_COUNT
                    ? { position: 'sticky' as const, left: STICKY_LEFT[c], zIndex: 11 }
                    : {}),
                }}
                className={`cursor-pointer border-r border-b border-slate-200 px-1.5 py-1.5 text-left text-xs font-medium whitespace-nowrap select-none ${
                  c > 0 && props.selectedCols.has(c)
                    ? 'bg-blue-200 text-blue-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <span className="mr-1 text-[10px] text-slate-400">{colLetter(c)}</span>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map(({ row, index }, i) => (
            <MasterRowView
              key={index}
              row={row}
              rowIndex={index}
              editingCol={editing?.rowIndex === index ? editing.col : null}
              selected={props.selected.has(index)}
              selectedCols={props.selectedCols}
              rangeCols={
                props.range && i >= props.range.v1 && i <= props.range.v2
                  ? [props.range.c1, props.range.c2]
                  : null
              }
              onFinishEdit={finishEdit}
            />
          ))}
          {props.rows.length === 0 && (
            <tr>
              <td colSpan={COL_LABELS.length} className="px-4 py-24 text-center">
                <div className="text-4xl">📥</div>
                <div className="mt-3 text-base font-medium text-slate-600">
                  {props.hasMaster
                    ? '没有匹配的行'
                    : '把「KK 询价汇总表」拖到窗口任意位置载入历史数据；也可以直接拖入供应商报价（将新建汇总）'}
                </div>
                <div className="mt-1.5 text-xs text-slate-400">
                  支持 .xlsx / .xlsm · 所有数据仅在本机处理，不会上传
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
