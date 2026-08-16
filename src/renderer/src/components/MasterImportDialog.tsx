import { isDataRow } from '@engine/index'
import { useSession } from '../store/session'

/** 拖入 KK 汇总表时的确认弹窗：替换当前汇总（并把该文件作为导出底版） */
export default function MasterImportDialog() {
  const pending = useSession((s) => s.pendingMaster)
  const master = useSession((s) => s.master)
  const masterDirty = useSession((s) => s.masterDirty)
  const confirmMasterImport = useSession((s) => s.confirmMasterImport)
  const cancelMasterImport = useSession((s) => s.cancelMasterImport)
  if (!pending) return null

  const currentRows = master ? master.rows.filter(isDataRow).length : 0

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <div data-testid="master-import-dialog" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-base font-bold">载入 KK 汇总表</h2>
        <p className="mt-2 text-sm text-slate-600">
          识别到汇总表 <span className="font-medium">{pending.fileName}</span>（{pending.dataRows} 行数据）。
        </p>
        {master ? (
          <p className="mt-2 text-sm text-slate-600">
            将<span className="font-medium text-red-600">替换</span>当前汇总（{currentRows} 行数据）
            {masterDirty && <span className="text-amber-600">，且当前有尚未导出的更改会丢失</span>}。
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-600">将作为历史汇总载入，之后的报价合并、编辑都在它之上进行。</p>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={cancelMasterImport}
            className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:bg-slate-100"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="confirm-master-import"
            onClick={confirmMasterImport}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            载入
          </button>
        </div>
      </div>
    </div>
  )
}
