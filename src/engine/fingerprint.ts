import { normalizeHeader } from './synonyms'
import type { Grid } from './types'

/**
 * 表头结构指纹：sha256(sheet 名 + 表头行号 + 归一化后的表头单元格序列)。
 * 同一供应商下次发来同格式文件时命中已保存的映射模板，免去人工确认。
 * 用 WebCrypto（浏览器与 Node ≥20 全局可用），不依赖 node:crypto。
 */
export async function sheetFingerprint(
  sheetName: string,
  grid: Grid,
  headerRow: number,
): Promise<string> {
  const headers = (grid[headerRow] ?? []).map((c) =>
    c && c.v !== null ? normalizeHeader(String(c.v)) : '',
  )
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop()
  const payload = JSON.stringify([sheetName, headerRow, headers])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
