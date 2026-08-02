import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VALID_KEYS = new Set(['settings', 'vendorRegistry', 'mappingTemplates', 'lastSession'])

function storeDir(): string {
  const dir = join(app.getPath('userData'), 'store')
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileOf(key: string): string {
  if (!VALID_KEYS.has(key)) throw new Error(`invalid store key: ${key}`)
  return join(storeDir(), `${key}.json`)
}

export function storeGet(key: string): unknown {
  const file = fileOf(key)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

export function storeSet(key: string, value: unknown): void {
  const file = fileOf(key)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, file)
}
