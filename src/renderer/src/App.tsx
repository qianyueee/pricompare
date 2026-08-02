import { useEffect, useState } from 'react'
import MappingDialog from './components/MappingDialog'
import Toast from './components/common/Toast'
import ComparePage from './pages/ComparePage'
import ImportPage from './pages/ImportPage'
import { useSession } from './store/session'

function TabButton(props: {
  active: boolean
  onClick: () => void
  testid: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      onClick={props.onClick}
      className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
        props.active ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-200'
      }`}
    >
      {props.children}
    </button>
  )
}

export default function App() {
  const [tab, setTab] = useState<'import' | 'compare'>('import')
  const init = useSession((s) => s.init)
  const files = useSession((s) => s.files)
  const confirmed = files.filter((f) => f.confirmed).length

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-8 border-b border-slate-200 bg-white px-6 py-3 shadow-sm">
        <div>
          <h1 className="text-lg font-bold leading-tight">询价比价系统</h1>
          <p className="text-xs text-slate-400">报价 Excel 统一解析 · 比价 · KK 格式导出</p>
        </div>
        <nav className="flex gap-1">
          <TabButton active={tab === 'import'} onClick={() => setTab('import')} testid="tab-import">
            ① 导入报价（{files.length}）
          </TabButton>
          <TabButton active={tab === 'compare'} onClick={() => setTab('compare')} testid="tab-compare">
            ② 比价与导出（已确认 {confirmed} 份）
          </TabButton>
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'import' ? <ImportPage /> : <ComparePage />}
      </main>
      <MappingDialog />
      <Toast />
    </div>
  )
}
