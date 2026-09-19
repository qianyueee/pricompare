import { normalizeHeader } from './synonyms'
import { letterToIdx } from './util'
import type { VendorGuess } from './types'
import type { MasterLayout } from './master/model'

export interface Vendor {
  id: string
  display: string
  /** KK 汇总模板里该供应商列的表头文字（按表头定位，模板插列后仍能对上） */
  kkHeader?: string
  /** 旧版：该供应商的传统列字母（I–N）；表头对不上时的兜底 */
  kkSlot?: string
  /** 识别别名：文件名 / 报价单号前缀 / 询价人列 / 模板列名 */
  aliases: string[]
}

/** 依据真实样本播种：凯阔的文件名是 KV*、单号 KV*、落 KK 的 SKW 列；HC 文件名 HCQuote*、单号 KT* */
export const SEED_VENDORS: Vendor[] = [
  { id: 'mao', display: 'Mao', kkHeader: 'Mao', kkSlot: 'I', aliases: ['mao'] },
  { id: 'hc', display: 'HC', kkHeader: 'HC', kkSlot: 'J', aliases: ['hc', 'hcquote', 'kt', 'kavis'] },
  { id: 'skw', display: 'SKW', kkHeader: 'SKW', kkSlot: 'K', aliases: ['skw', 'kv', '凯阔'] },
  { id: 'by', display: 'BY', kkHeader: 'BY', kkSlot: 'L', aliases: ['by'] },
  { id: 'yj', display: 'YJ', kkHeader: 'YJ', kkSlot: 'M', aliases: ['yj'] },
  { id: 'jm', display: 'JM', kkHeader: 'JM', kkSlot: 'N', aliases: ['jm'] },
]

/**
 * 供应商 → 汇总表里的价格列（物理列号）：先按表头文字（kkHeader / 显示名 / 别名）在
 * layout.vendorSlots 里找，找不到再用旧版列字母兜底（且该列必须仍是供应商列）；都没有 → null。
 */
export function resolveVendorSlot(
  layout: MasterLayout,
  vendor: { display: string; kkHeader?: string; kkSlot?: string; aliases?: string[] },
): number | null {
  const keys = [vendor.kkHeader, vendor.display, ...(vendor.aliases ?? [])]
    .filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    .map((k) => normalizeHeader(k))
  for (const key of keys) {
    const hit = layout.vendorSlots.find((s) => normalizeHeader(s.label) === key)
    if (hit) return hit.col
  }
  if (vendor.kkSlot) {
    const col = letterToIdx(vendor.kkSlot)
    if (layout.vendorSlots.some((s) => s.col === col)) return col
  }
  return null
}

export interface VendorGuessInput {
  fileName: string
  quoteNos: string[]
  /** 询价人/批次列的样本值 */
  nameValues: string[]
  /** 被选为单价列的表头文字 */
  priceHeader: string
}

/**
 * 供应商归属按【文件】判定（供应商借用模板里别家的列填价的情况按文件名/单号纠正）。
 * 得分 = 3·文件名命中 + 2·报价单号前缀命中 + 1·询价人列命中 + 1·填价列表头命中。
 */
export function guessVendor(vendors: Vendor[], input: VendorGuessInput): VendorGuess {
  const fn = input.fileName.toLowerCase()
  let best: VendorGuess = { vendorId: null, score: 0, evidence: [] }
  for (const v of vendors) {
    let score = 0
    const evidence: string[] = []
    const aliases = [...new Set([...v.aliases, v.id, v.display].map((a) => a.toLowerCase()))].filter(
      (a) => a.length >= 2,
    )
    const fnHits = aliases.filter((a) => fn.includes(a)).sort((a, b) => b.length - a.length)
    if (fnHits.length > 0) {
      score += 3
      evidence.push(`文件名含「${fnHits[0]}」`)
    }
    const prefixes = new Set(
      input.quoteNos
        .map((q) => q.toLowerCase().match(/^[a-z]+/)?.[0] ?? '')
        .filter((p) => p.length >= 2),
    )
    for (const p of prefixes) {
      if (aliases.includes(p)) {
        score += 2
        evidence.push(`报价单号前缀「${p.toUpperCase()}」`)
        break
      }
    }
    if (input.nameValues.some((nv) => aliases.some((a) => nv.toLowerCase().includes(a)))) {
      score += 1
      evidence.push('询价人列命中')
    }
    const ph = normalizeHeader(input.priceHeader)
    if (ph && aliases.some((a) => normalizeHeader(a) === ph)) {
      score += 1
      evidence.push(`价格填在「${input.priceHeader.replace(/\s+/g, ' ').trim()}」列`)
    }
    if (score > best.score) best = { vendorId: v.id, score, evidence }
  }
  return best
}
