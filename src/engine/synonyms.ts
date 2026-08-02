import type { FieldKey } from './types'

/**
 * 表头归一化：小写 → 全角转半角 → 去掉所有空白（含 \n、nbsp、全角空格）→ 去尾部冒号。
 * 真实样本里表头带内嵌换行（"Quote \n(each)"）和双空格（"Quote  (EA)"），必须全部抹平。
 */
export function normalizeHeader(input: unknown): string {
  let s = String(input ?? '').toLowerCase()
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  s = s.replace(/[\s\u00a0\u2000-\u200b\u3000]+/g, '')
  s = s.replace(/[:：]+$/g, '')
  return s
}

/** 去掉括号注释（归一化后括号已是半角）："p/n(零件编号)" → "p/n" */
export function stripParens(s: string): string {
  return s.replace(/\([^()]*\)/g, '')
}

/** 纯数字（" 2"…" 9"）、"Column1" 之类的垃圾表头 */
const JUNK_HEADER_RE = /^(\d+|column\d*|列\d*)$/

/** 衍生/成本类列，不是供应商报出的单价，模糊匹配阶段直接忽略 */
const DERIVED_HEADER_RE = /cost|total|总价|金额|shipping|freight|运费|快递|tariff|关税|^usd$/

export const FIELD_LABELS: Record<FieldKey, string> = {
  no: '序号',
  name: '询价批次',
  item: '项次',
  pn: '零件号 P/N',
  rev: '版本 Rev',
  description: '描述',
  qty: '数量',
  price: '单价（本次报价）',
  leadTime: '交期',
  material: '材料',
  surfaceFinish: '表面处理',
  cleaningSpec: '清洗标准',
  process: '工艺',
  size: '尺寸',
  quoteNo: '报价单号',
  remark: '备注',
  basePn: '基础件号',
  partType: '类型',
  ignore: '忽略',
}

const SYNONYMS: Record<Exclude<FieldKey, 'ignore'>, string[]> = {
  no: ['no', 'no.', '序号'],
  name: ['name', '询价人', '询价批次'],
  item: ['item', '项次', '项目号'],
  pn: ['p/n', 'pn', 'partno', 'partno.', 'partnumber', '零件编号', '零件号', '料号', '图号'],
  rev: ['rev', 'rev.', '版本', '版本号'],
  description: ['description', '描述', '品名', '名称'],
  qty: ["q'ty", 'qty', 'quantity', '数量'],
  price: [
    'quote(each)',
    'quoteeach',
    'quoteeachrmb',
    '单价',
    '含税单价',
    '未税单价',
    '不含税单价',
    'unitprice',
    'price',
    '报价',
  ],
  leadTime: [
    'leadtime',
    'leadtime(calendardays)',
    '交期',
    '交货期',
    '货期',
    '交付周期',
    '交货周期',
    'deliverytime',
    'delivery',
    'l/t',
  ],
  material: ['material', '材料', '材质'],
  surfaceFinish: ['surfacefinish', '表面处理'],
  cleaningSpec: ['cleaningspec', 'cleaning清洗标准', '清洗标准'],
  process: ['process', 'method', '工艺', '加工方式'],
  size: ['size', '尺寸'],
  quoteNo: ['quoteno', 'quoteno.', 'quote#', 'quotenumber', '报价单号'],
  remark: ['备注', 'comment', 'comments', 'remark', 'remarks', 'note', 'notes'],
  basePn: ['basep/n', 'basepn'],
  partType: ['type', '类型'],
}

const FIELD_ENTRIES = Object.entries(SYNONYMS) as [Exclude<FieldKey, 'ignore'>, string[]][]

export interface FieldMatch {
  field: FieldKey
  confidence: number
}

/**
 * 表头 → 字段。精确 1.0；去括号后精确 0.8；包含同义词 0.6；否则 ignore。
 * 垃圾表头与衍生成本列（Material Cost / Shipping 等）直接 ignore。
 */
export function matchField(header: unknown): FieldMatch {
  const n = normalizeHeader(header)
  if (!n) return { field: 'ignore', confidence: 0 }
  if (JUNK_HEADER_RE.test(n)) return { field: 'ignore', confidence: 1 }
  for (const [field, syns] of FIELD_ENTRIES) {
    if (syns.includes(n)) return { field, confidence: 1 }
  }
  const p = stripParens(n)
  if (p && p !== n) {
    for (const [field, syns] of FIELD_ENTRIES) {
      if (syns.includes(p)) return { field, confidence: 0.8 }
    }
  }
  if (DERIVED_HEADER_RE.test(n)) return { field: 'ignore', confidence: 0 }
  for (const [field, syns] of FIELD_ENTRIES) {
    for (const syn of syns) {
      const minLen = /[\u4e00-\u9fff]/.test(syn) ? 2 : 4
      if (syn.length >= minLen && n.includes(syn)) return { field, confidence: 0.6 }
    }
  }
  return { field: 'ignore', confidence: 0 }
}

export const ALL_FIELDS: FieldKey[] = [
  'pn',
  'rev',
  'description',
  'qty',
  'price',
  'leadTime',
  'quoteNo',
  'material',
  'surfaceFinish',
  'cleaningSpec',
  'process',
  'size',
  'remark',
  'basePn',
  'partType',
  'name',
  'item',
  'no',
  'ignore',
]
