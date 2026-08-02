import { useState } from 'react'
import { buildKkWorkbook } from '@engine/index'
import type { CompareResult } from '@engine/types'
import { api } from '../../api'
import { useSession } from '../../store/session'
import { todayYmd } from '../../utils/format'

export default function ExportBar({ result }: { result: CompareResult }) {
  const usdRate = useSession((s) => s.usdRate)
  const setUsdRate = useSession((s) => s.setUsdRate)
  const batchName = useSession((s) => s.batchName)
  const setBatchName = useSession((s) => s.setBatchName)
  const registry = useSession((s) => s.registry)
  const showToast = useSession((s) => s.showToast)
  const [busy, setBusy] = useState(false)

  const onExport = async () => {
    setBusy(true)
    try {
      const out = await buildKkWorkbook(result, {
        batchName,
        usdRate,
        registry,
        displayNames: Object.fromEntries(result.vendors.map((v) => [v.vendorId, v.vendorDisplay])),
      })
      if (out.warnings.length > 0 && !window.confirm(`${out.warnings.join('\n')}\n\n继续导出？`)) {
        return
      }
      const saved = await api.saveXlsx({
        defaultFileName: `KK汇总_${todayYmd()}.xlsx`,
        data: out.buffer,
      })
      if (saved.saved) {
        showToast({ message: 'KK 汇总已导出', path: saved.path })
      }
    } catch (err) {
      showToast({ message: `导出失败：${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <label className="flex flex-col gap-1 text-xs text-slate-500">
        美元汇率（USD → RMB）
        <input
          data-testid="rate-input"
          type="number"
          step="0.01"
          min="0.01"
          value={usdRate}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v > 0) setUsdRate(v)
          }}
          className="w-32 rounded-md border border-slate-300 px-2 py-1.5 text-sm tabular-nums"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500">
        汇总名称（写入 Name 列）
        <input
          data-testid="batch-input"
          value={batchName}
          onChange={(e) => setBatchName(e.target.value)}
          className="w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>
      <div className="flex-1" />
      <button
        type="button"
        data-testid="export-btn"
        disabled={busy || result.rows.length === 0}
        onClick={() => void onExport()}
        className="rounded-lg bg-green-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy ? '导出中…' : '导出 KK 汇总 Excel'}
      </button>
    </div>
  )
}
