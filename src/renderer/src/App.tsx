import { useEffect, useRef, useState } from 'react'
import MappingDialog from './components/MappingDialog'
import MasterImportDialog from './components/MasterImportDialog'
import NegoPanel from './components/NegoPanel'
import Toast from './components/common/Toast'
import MainPage from './pages/MainPage'
import { useSession } from './store/session'

const ACCEPT_RE = /\.(xlsx|xlsm|xls|csv)$/i

/** 整个窗口都是拖放目标：拖入文件时显示全屏遮罩，松手即导入 */
function useWindowDrop() {
  const addFiles = useSession((s) => s.addFiles)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => ACCEPT_RE.test(f.name))
      if (files.length > 0) void addFiles(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  return dragging
}

export default function App() {
  const init = useSession((s) => s.init)
  const dragging = useWindowDrop()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="flex h-full flex-col">
      <MainPage />
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center rounded-lg border-4 border-dashed border-blue-500 bg-blue-500/10">
          <div className="rounded-2xl bg-white px-8 py-5 text-lg font-semibold text-blue-600 shadow-xl">
            松开鼠标，导入报价文件
          </div>
        </div>
      )}
      <MasterImportDialog />
      <MappingDialog />
      <NegoPanel />
      <Toast />
    </div>
  )
}
