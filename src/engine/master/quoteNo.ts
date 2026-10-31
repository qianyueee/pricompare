import { KK_COL } from '../export/kkLayout'
import type { MasterData } from './model'

/**
 * V 列报价单号（Zane 2026-10-31）：KZ + 收到报价的日期 + 字母，如 KZ20261031A。
 * - 同一询价组（B 列）同一天收到的报价共用一个单号，同组多行、HC 和 SKW 都用它；
 * - 同一天的下一个询价组顺延 B、C、D……，Z 之后接 AA、AB……（同 Excel 列名）；
 * - 只写进 V 还空着的行，已有的单号（历史的 KV…、更早的 KZ…）不动。
 * 字母取当天已用过的最大字母的下一个，删掉的行的单号也不会被后来的组重用（只要表里还留着更靠后的字母）。
 */
export const KZ_PREFIX = 'KZ'

const KZ_RE = /^KZ(\d{8})([A-Z]+)$/

/** 0 → A，25 → Z，26 → AA，27 → AB…… */
export function seqLetters(n: number): string {
  let s = ''
  let i = n + 1
  while (i > 0) {
    const r = (i - 1) % 26
    s = String.fromCharCode(65 + r) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

/** seqLetters 的反函数：A → 0，Z → 25，AA → 26 */
export function seqIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 本机时区的今天，YYYYMMDD */
export function todayYmd(now: Date = new Date()): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
}

/**
 * 收到报价的日期 → YYYYMMDD。接受 20261031、2026-10-31、2026/10/31，
 * 以及邮件日期原文（2026-10-31T10:05:00+08:00，按原文写的日期取，不换时区）。认不出返回 null。
 */
export function normalizeReceivedDate(input: string | undefined | null): string | null {
  const t = String(input ?? '').trim()
  const m = t.match(/^(\d{4})(\d{2})(\d{2})$/) ?? t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return `${y}${pad2(mo)}${pad2(d)}`
}

/**
 * 这个询价组在 ymd 这天的单号：表里同组已有当天的 KZ 单号就沿用（同一天里 HC、SKW 先后回、或分几次并入），
 * 否则取当天下一个字母。
 */
export function kzQuoteNo(master: MasterData, batch: string, ymd: string): string {
  const b = batch.trim()
  let max = -1
  for (const row of master.rows) {
    const v = row.cells[KK_COL.quoteNo]
    if (v === null || v === undefined || v === '') continue
    for (const part of String(v).split('/')) {
      const m = part.trim().toUpperCase().match(KZ_RE)
      if (!m || m[1] !== ymd) continue
      if (b && String(row.cells[KK_COL.name] ?? '').trim() === b) return `${KZ_PREFIX}${ymd}${m[2]}`
      max = Math.max(max, seqIndex(m[2]!))
    }
  }
  return `${KZ_PREFIX}${ymd}${seqLetters(max + 1)}`
}
