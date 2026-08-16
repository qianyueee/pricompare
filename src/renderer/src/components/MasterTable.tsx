import { memo, useEffect, useRef, useState } from 'react'
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
      className="h-full w-full border-2 border-blue-500 bg-white px-1 py-0.5 text-xs outline-none"
    />
  )
}

interface RowProps {
  row: MasterRow
  rowIndex: number
  editingCol: number | null
  onStartEdit: (rowIndex: number, col: number) => void
  onFinishEdit: (rowIndex: number, col: number, value: string | null) => void
}

const MasterRowView = memo(function MasterRowView({
  row,
  rowIndex,
  editingCol,
  onStartEdit,
  onFinishEdit,
}: RowProps) {
  // 供应商列最低价高亮（≥2 家有数值才标）
  const prices = VENDOR_SLOTS.map((c) => parsePriceNum(row.cells[c] ?? null))
  const valid = prices.filter((p): p is number => p !== null)
  const min = valid.length >= 2 ? Math.min(...valid) : null

  return (
    <tr data-testid="master-row" className="group hover:bg-blue-50/40">
      {row.cells.map((v, c) => {
        const isSticky = c < STICKY_COUNT
        const isVendor = c >= 8 && c <= 13
        const num = isVendor ? parsePriceNum(v) : null
        const isMin = min !== null && num !== null && num === min
        const isTdb = isVendor && typeof v === 'string' && /tdb|tbd|待定/i.test(v)
        const isEditing = editingCol === c
        return (
          <td
            key={c}
            data-cell={`${rowIndex}:${c}`}
            onClick={c === 0 || isEditing ? undefined : () => onStartEdit(rowIndex, c)}
            title={cellText(v)}
            style={{
              minWidth: COL_WIDTHS[c],
              maxWidth: COL_WIDTHS[c]! * 1.6,
              ...(isSticky ? { position: 'sticky' as const, left: STICKY_LEFT[c], zIndex: 1 } : {}),
            }}
            className={`overflow-hidden border-r border-b border-slate-100 px-1.5 py-0.5 text-xs text-ellipsis whitespace-nowrap ${
              c === 0 ? 'bg-slate-50 text-center text-slate-400' : 'cursor-text'
            } ${isSticky && c !== 0 ? 'bg-white group-hover:bg-blue-50' : ''} ${
              c === KK_COL.pn ? 'font-mono font-medium' : ''
            } ${isMin ? 'bg-green-100 font-semibold text-green-700' : ''} ${
              isTdb ? 'bg-amber-50 text-amber-700' : ''
            } ${c === KK_COL.quoteEach ? 'bg-blue-50/60 font-medium' : ''} ${isEditing ? 'p-0' : ''}`}
          >
            {isEditing ? (
              <CellEditor initial={cellText(v)} onDone={(value) => onFinishEdit(rowIndex, c, value)} />
            ) : (
              cellText(v)
            )}
          </td>
        )
      })}
    </tr>
  )
})

export default function MasterTable(props: {
  rows: { row: MasterRow; index: number }[]
  hasMaster: boolean
}) {
  const editMasterCell = useSession((s) => s.editMasterCell)
  const [editing, setEditing] = useState<{ rowIndex: number; col: number } | null>(null)

  const finishEdit = (rowIndex: number, col: number, value: string | null) => {
    setEditing(null)
    if (value !== null) editMasterCell(rowIndex, col, value)
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table data-testid="master-table" className="border-separate border-spacing-0">
        <thead className="sticky top-0 z-10">
          <tr>
            {COL_LABELS.map((label, c) => (
              <th
                key={c}
                style={{
                  minWidth: COL_WIDTHS[c],
                  ...(c < STICKY_COUNT
                    ? { position: 'sticky' as const, left: STICKY_LEFT[c], zIndex: 11 }
                    : {}),
                }}
                className="border-r border-b border-slate-200 bg-slate-100 px-1.5 py-1.5 text-left text-xs font-medium whitespace-nowrap text-slate-600"
              >
                <span className="mr-1 text-[10px] text-slate-400">{colLetter(c)}</span>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map(({ row, index }) => (
            <MasterRowView
              key={index}
              row={row}
              rowIndex={index}
              editingCol={editing?.rowIndex === index ? editing.col : null}
              onStartEdit={(r, c) => setEditing({ rowIndex: r, col: c })}
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
