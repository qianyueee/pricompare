// pricompare 命令行：给每小时的自动导入和手工维护用，经本机服务改总表（排队、记历史、网页实时刷新）。
//   node cli.mjs import-master <KK询价汇总表.xlsm>   整表导入（替换当前总表并保存原件）
//   node cli.mjs status                              服务、总表版本和最近几次改动
// 环境变量 PRICOMPARE_URL 可改服务地址，默认 http://127.0.0.1:8790
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { cleanMasterAmounts } from '../engine/master/clean'
import { isDataRow, parseMasterWorkbook } from '../engine/master/model'
import { readWorkbook } from '../engine/workbook'
import {
  CLIENT_HEADER,
  type HistoryEntry,
  type ImportMasterRequest,
  type MasterSnapshot,
  type ServerSession,
} from '../shared/serverApi'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string', default: process.env.PRICOMPARE_URL ?? 'http://127.0.0.1:8790' } },
})
const base = values.url!.replace(/\/$/, '')

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1', 'x-pri-source': 'cli' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((err: unknown) => {
    throw new Error(`连不上 pricompare 服务（${base}）：${err instanceof Error ? err.message : String(err)}`)
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

async function importMaster(file: string | undefined): Promise<void> {
  if (!file) throw new Error('用法：import-master <KK询价汇总表.xlsm>')
  const buf = await readFile(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const parsed = parseMasterWorkbook(readWorkbook(ab), basename(file))
  if (!parsed) throw new Error(`${basename(file)} 不是 KK 询价汇总表`)
  const { master, changed } = cleanMasterAmounts(parsed)
  const body: ImportMasterRequest = { master, file: { name: basename(file), b64: buf.toString('base64') } }
  const { version } = await call<{ version: number }>('POST', '/api/master/import', body)
  const rows = master.rows.filter(isDataRow).length
  console.log(`已导入 ${basename(file)}：${rows} 行数据，规范 ${changed} 个文本金额，总表版本 ${version}`)
}

async function status(): Promise<void> {
  const session = await call<ServerSession>('GET', '/api/session')
  const snap = await call<MasterSnapshot>('GET', '/api/master')
  const history = await call<HistoryEntry[]>('GET', '/api/history?limit=10')
  const rows = snap.master?.rows.filter(isDataRow).length ?? 0
  console.log(`服务 ${base} · 身份 ${session.user}（${session.role}）· 总表版本 ${snap.version} · ${rows} 行数据`)
  for (const h of history) console.log(`  v${h.version}  ${h.at}  ${h.user}/${h.source}  ${h.summary}`)
}

const [cmd, ...rest] = positionals
try {
  if (cmd === 'import-master') await importMaster(rest[0])
  else if (cmd === 'status') await status()
  else {
    console.error('用法：cli.mjs import-master <文件> | status')
    process.exitCode = 2
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
