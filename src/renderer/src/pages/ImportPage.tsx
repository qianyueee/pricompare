import DropZone from '../components/DropZone'
import FileCard from '../components/FileCard'
import { useSession } from '../store/session'

export default function ImportPage() {
  const files = useSession((s) => s.files)
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <DropZone />
      {files.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {files.map((f) => (
            <FileCard key={f.id} file={f} />
          ))}
        </div>
      )}
      {files.length === 0 && (
        <div className="text-center text-xs leading-relaxed text-slate-400">
          导入后系统会自动识别表头、零件号、单价与交期列；不确定的地方会弹出确认界面让你修正。
          <br />
          同一供应商的格式确认一次后会被记住，下次拖入免确认。
        </div>
      )}
    </div>
  )
}
