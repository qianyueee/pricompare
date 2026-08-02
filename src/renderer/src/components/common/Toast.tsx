import { useEffect } from 'react'
import { api } from '../../api'
import { useSession } from '../../store/session'

export default function Toast() {
  const toast = useSession((s) => s.toast)
  const showToast = useSession((s) => s.showToast)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => showToast(null), 8000)
    return () => clearTimeout(t)
  }, [toast, showToast])

  if (!toast) return null
  return (
    <div
      data-testid="toast"
      className="fixed right-6 bottom-6 z-50 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-lg"
    >
      <span className="whitespace-pre-line">{toast.message}</span>
      {toast.path && api.isDesktop && (
        <button
          type="button"
          onClick={() => void api.showInFolder(toast.path!)}
          className="rounded-md bg-slate-100 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
        >
          在文件夹中显示
        </button>
      )}
      <button type="button" onClick={() => showToast(null)} className="text-slate-300 hover:text-slate-500">
        ✕
      </button>
    </div>
  )
}
