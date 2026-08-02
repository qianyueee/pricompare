export type Currency = 'RMB' | 'USD'

export type PriceStatus = 'ok' | 'pending' | 'invalid' | 'empty'

export interface PriceValue {
  status: PriceStatus
  amount?: number
  currency: Currency
  /** 单元格原文（清洗前），始终保留供展示 */
  raw: string
}

export interface LeadTime {
  /** 交期原文，始终保留并展示 */
  raw: string
  /** 尽力解析出的天数（区间取上限、周×7、月×30），解析不了为 null */
  days: number | null
}

export interface Cell {
  v: string | number | null
  /** Excel 公式错误单元格（#REF! / #N/A 等） */
  isError: boolean
  /** 格式化显示文本（错误单元格为错误码原文） */
  w?: string
}

/** 0 基 [行][列] 网格；空单元格为 undefined */
export type Grid = (Cell | undefined)[][]

export type FieldKey =
  | 'no'
  | 'name'
  | 'item'
  | 'pn'
  | 'rev'
  | 'description'
  | 'qty'
  | 'price'
  | 'leadTime'
  | 'material'
  | 'surfaceFinish'
  | 'cleaningSpec'
  | 'process'
  | 'size'
  | 'quoteNo'
  | 'remark'
  | 'basePn'
  | 'partType'
  | 'ignore'

export interface ColumnMapping {
  /** 0 基表头行号 */
  headerRow: number
  /** 列号(0基) → 字段 */
  map: Record<number, FieldKey>
  /** 单价列（0 基），-1 = 未选定 */
  priceCol: number
  /** 单价列默认币种（单元格内的 ￥/$ 符号可逐值覆盖） */
  priceCurrency: Currency
  /** 列号 → 自动识别置信度（1 精确 / 0.8 去括号 / 0.6 模糊） */
  confidence: Record<number, number>
}

export interface PriceCandidate {
  col: number
  header: string
  score: number
  numericCount: number
  rowCount: number
  sampleValues: string[]
  currencyGuess: Currency
}

/** 统一后的一行报价（一个零件的一个数量档位，来自某一家的文件） */
export interface QuoteRow {
  pn: string
  /** 已去空格转大写；无版本为 '' */
  rev: string
  qty: number | null
  price: PriceValue
  leadTime: LeadTime
  description: string
  material: string
  surfaceFinish: string
  cleaningSpec: string
  process: string
  size: string
  quoteNo: string
  remark: string
  basePn: string
  partType: string
  /** 1 基 Excel 行号，供预览定位 */
  sourceRow: number
}

export interface VendorGuess {
  vendorId: string | null
  score: number
  evidence: string[]
}

export interface AnalyzedSheet {
  sheetName: string
  headerRow: number
  headerScore: number
  /** 表头识别分数过低，需要人工在预览里指定表头行 */
  needsManualHeader: boolean
  mapping: ColumnMapping
  candidates: PriceCandidate[]
  fingerprint: string
  vendorGuess: VendorGuess
  rows: QuoteRow[]
  warnings: string[]
  /** 前若干行原始网格（含表头前的行），供映射确认界面预览 */
  preview: Grid
  columnCount: number
}

/** 比价输入：同一供应商的全部报价行（可能来自多个文件合并） */
export interface VendorQuotes {
  vendorId: string
  vendorDisplay: string
  rows: QuoteRow[]
}

export interface CompareCell {
  price: PriceValue
  /** 人民币等值单价（USD × 汇率），非 ok 状态为 null */
  rmbEquivalent: number | null
  leadTime: LeadTime
  /** 相对本行最低价的溢价比例，最低价为 0；单家报价/非 ok 为 null */
  deltaPct: number | null
  isMin: boolean
  source: QuoteRow
}

export interface CompareRow {
  /** pn␟REV␟qty */
  key: string
  pn: string
  rev: string
  qty: number | null
  description: string
  cells: Record<string, CompareCell | undefined>
  minRmb: number | null
  okCount: number
  /** 只有一家给出有效报价 */
  singleQuote: boolean
}

export interface VendorTotal {
  vendorId: string
  quotedRows: number
  missingRows: number
  /** 已报行人民币等值单价合计 */
  sumUnit: number
  /** 单价 × 数量 合计（缺数量的行不计入） */
  sumExtended: number
  extendedRows: number
}

export interface CompareResult {
  vendors: { vendorId: string; vendorDisplay: string }[]
  rows: CompareRow[]
  totals: {
    perVendor: VendorTotal[]
    /** 每行取最低价的单价合计 */
    bestUnitSum: number
    /** 每行取最低价的 单价×数量 合计 */
    bestExtendedSum: number
    comparableRows: number
  }
  warnings: string[]
}
