import { useMemo, useState } from 'react'
import {
  ALL_FIELDS,
  FIELD_LABELS,
  colLetter,
  type Cell,
  type ColumnMapping,
  type FieldKey,
} from '@engine/index'
import { useSession, type LoadedFile } from '../store/session'

function cellText(cell: Cell | undefined): string {
  if (!cell) return ''
  if (cell.isError) return cell.w ?? '#ERROR'
  if (cell.v === null) return ''
  return String(cell.v)
}

function Inner({ file }: { file: LoadedFile }) {
  const analysis = file.analysis!
  const closeMapping = useSession((s) => s.closeMapping)
  const confirmMapping = useSession((s) => s.confirmMapping)
  const setHeaderRow = useSession((s) => s.setHeaderRow)
  const registry = useSession((s) => s.registry)

  const [draftMap, setDraftMap] = useState<Record<number, FieldKey>>(() => ({ ...analysis.mapping.map }))
  const [priceCol, setPriceCol] = useState(analysis.mapping.priceCol)
  const [currency, setCurrency] = useState(analysis.mapping.priceCurrency)
  const [vendor, setVendor] = useState(file.vendorDisplay)
  const [saveTemplate, setSaveTemplate] = useState(true)
  const [busy, setBusy] = useState(false)

  const cols = useMemo(() => Array.from({ length: analysis.columnCount }, (_, i) => i), [analysis])

  const setField = (col: number, field: FieldKey) => {
    setDraftMap((prev) => {
      const next = { ...prev }
      if (field === 'ignore') {
        delete next[col]
      } else {
        // 同一字段只保留一列（price 由 priceCol 单独管理）
        for (const [cStr, f] of Object.entries(next)) {
          if (f === field && Number(cStr) !== col) delete next[Number(cStr)]
        }
        next[col] = field
      }
      return next
    })
    if (field === 'price') {
      setPriceCol(col)
      const cand = analysis.candidates.find((c) => c.col === col)
      if (cand) setCurrency(cand.currencyGuess)
    } else if (col === priceCol) {
      setPriceCol(-1)
    }
  }

  const pnMapped = Object.values(draftMap).includes('pn')
  const canConfirm = pnMapped && priceCol >= 0 && vendor.trim() !== '' && !busy

  const onConfirm = async () => {
    setBusy(true)
    const map = { ...draftMap }
    for (const [cStr, f] of Object.entries(map)) {
      if (f === 'price' && Number(cStr) !== priceCol) delete map[Number(cStr)]
    }
    map[priceCol] = 'price'
    const mapping: ColumnMapping = {
      headerRow: analysis.headerRow,
      map,
      priceCol,
      priceCurrency: currency,
      confidence: analysis.mapping.confidence,
    }
    await confirmMapping({ fileId: file.id, mapping, vendorDisplay: vendor, saveTemplate })
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        data-testid="mapping-dialog"
        className="flex max-h-[92vh] w-full max-w-6xl flex-col gap-3 overflow-hidden rounded-2xl bg-white p-5 shadow-2xl"
      >
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-base font-bold">确认列映射 · {file.fileName}</h2>
            <p className="text-xs text-slate-500">
              工作表「{analysis.sheetName}」 · 表头第 {analysis.headerRow + 1} 行（点击左侧行号可改）
              {analysis.needsManualHeader && <span className="text-amber-600">（自动识别不可靠，请核对）</span>}
            </p>
          </div>
          <button type="button" onClick={closeMapping} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            供应商（本文件归属）
            <input
              data-testid="vendor-input"
              list="vendor-datalist"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="如：SKW / 凯阔"
              className="w-48 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <datalist id="vendor-datalist">
              {registry.map((v) => (
                <option key={v.id} value={v.display} />
              ))}
            </datalist>
          </label>
          {analysis.vendorGuess.evidence.length > 0 && (
            <div className="pb-1 text-xs text-slate-400">识别依据：{analysis.vendorGuess.evidence.join('；')}</div>
          )}
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            价格币种
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as 'RMB' | 'USD')}
              className="w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="RMB">人民币 ¥</option>
              <option value="USD">美元 $</option>
            </select>
          </label>
        </div>

        {analysis.candidates.length > 0 && (
          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium text-slate-500">单价列（自动按数值密度推荐）</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {analysis.candidates.slice(0, 4).map((c) => (
                <label key={c.col} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="price-col"
                    checked={priceCol === c.col}
                    onChange={() => setField(c.col, 'price')}
                  />
                  <span className="font-medium">
                    列{colLetter(c.col)} {c.header.replace(/\s+/g, ' ').trim() || '（无表头）'}
                  </span>
                  <span className="text-xs text-slate-400">
                    {c.numericCount}/{c.rowCount} 行有数值
                    {c.sampleValues.length > 0 && ` · 例：${c.sampleValues.join(' / ')}`}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200">
          <table className="min-w-max border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-white shadow-sm">
              <tr>
                <th className="border-b border-r border-slate-200 bg-slate-50 px-1 text-slate-400">行</th>
                {cols.map((c) => {
                  const field = c === priceCol ? 'price' : (draftMap[c] ?? 'ignore')
                  const conf = analysis.mapping.confidence[c]
                  return (
                    <th key={c} className="border-b border-r border-slate-200 px-1 py-1 align-bottom">
                      <div className="mb-0.5 text-center font-normal text-slate-400">{colLetter(c)}</div>
                      <select
                        value={field}
                        onChange={(e) => setField(c, e.target.value as FieldKey)}
                        className={`w-full min-w-20 rounded border px-1 py-0.5 text-xs ${
                          field === 'ignore'
                            ? 'border-slate-200 text-slate-400'
                            : field === 'price'
                              ? 'border-green-400 bg-green-50 font-medium text-green-700'
                              : conf === 1
                                ? 'border-blue-300 bg-blue-50 text-blue-700'
                                : 'border-amber-300 bg-amber-50 text-amber-700'
                        }`}
                      >
                        {ALL_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {analysis.preview.map((row, r) => (
                <tr key={r} className={r === analysis.headerRow ? 'bg-blue-50 font-medium' : 'hover:bg-slate-50'}>
                  <td
                    onClick={() => void setHeaderRow(file.id, r)}
                    title="点击设为表头行"
                    className={`cursor-pointer border-b border-r border-slate-100 px-1.5 text-center ${
                      r === analysis.headerRow ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-blue-100'
                    }`}
                  >
                    {r + 1}
                  </td>
                  {cols.map((c) => {
                    const t = cellText(row?.[c])
                    return (
                      <td
                        key={c}
                        title={t}
                        className="max-w-40 truncate border-b border-r border-slate-100 px-1.5 py-0.5 whitespace-nowrap"
                      >
                        {t}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {analysis.warnings.length > 0 && (
          <ul className="text-xs text-amber-600">
            {analysis.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input type="checkbox" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} />
            记住此格式（下次同格式文件自动映射）
          </label>
          <div className="flex items-center gap-3">
            {!canConfirm && !busy && (
              <span className="text-xs text-red-500">
                {!pnMapped ? '请为零件号 P/N 指定一列' : priceCol < 0 ? '请选择单价列' : vendor.trim() === '' ? '请填写供应商' : ''}
              </span>
            )}
            <button
              type="button"
              onClick={closeMapping}
              className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:bg-slate-100"
            >
              稍后处理
            </button>
            <button
              type="button"
              data-testid="confirm-mapping"
              disabled={!canConfirm}
              onClick={() => void onConfirm()}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {busy ? '导入中…' : '确认导入'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function MappingDialog() {
  const fileId = useSession((s) => s.activeMappingFileId)
  const file = useSession((s) => s.files.find((f) => f.id === fileId))
  if (!file || file.status !== 'ok' || !file.analysis) return null
  const key = `${file.id}:${file.analysis.sheetName}:${file.analysis.headerRow}`
  return <Inner key={key} file={file} />
}
