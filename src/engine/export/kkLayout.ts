/**
 * KK 汇总模板布局常量。表头 34 列（A–AH）从用户真实 KK询价汇总表20261012.xlsm 的「KK询价汇总」
 * 逐字节复刻：注意 H/X 列内嵌换行、U 列双空格、Y 列全角括号前有空格。
 *
 * 2026-10-07 起的新布局：I–N 为 Mao/HC/SKW/CL/BY/JM（L 列新增宸立 CL），YJ 挪到 AG，Base ID 顺延到 AH。
 * 旧布局（33 列，I–N 为 Mao/HC/SKW/BY/YJ/JM）见 KK_LEGACY_HEADERS，导入时按表头对位迁移。
 */
export const KK_SHEET_NAME = 'KK询价汇总'

export const KK_HEADERS: readonly string[] = [
  'No.',
  'Name',
  'Item',
  'P/N',
  'Rev',
  'Description',
  "Q'ty",
  'Quote \n(each)',
  'Mao',
  'HC',
  'SKW',
  'CL',
  'BY',
  'JM',
  'US Vendor (US$)',
  'USD',
  'Cleaning',
  'Material Cost',
  'Shipping+Tariff',
  'Cost',
  'Quote  (EA)',
  'Quote #',
  'Lead Time',
  'Material \n（材料）',
  'Surface Finish （表面处理）',
  'Cleaning Spec',
  'Process',
  'Size',
  'Type',
  'Comment',
  'Comment 2',
  'Base P/N',
  'YJ',
  'Base ID',
]

/** 10-07 之前 pricompare 使用的 33 列旧布局（A–AG）；只用于迁移旧数据 */
export const KK_LEGACY_HEADERS: readonly string[] = [
  ...KK_HEADERS.slice(0, 11), // A–K
  'BY',
  'YJ',
  'JM',
  ...KK_HEADERS.slice(14, 32), // O–AF
  'Base ID',
]

/** 0 基列号（对应 KK_HEADERS 下标） */
export const KK_COL = {
  no: 0,
  name: 1,
  item: 2,
  pn: 3,
  rev: 4,
  description: 5,
  qty: 6,
  quoteEach: 7,
  vendorSlotStart: 8, // I 列 Mao
  vendorSlotEnd: 13, // N 列 JM
  usVendor: 14, // O 列
  usd: 15, // P 列
  quoteEa: 20, // U 列
  quoteNo: 21, // V 列
  leadTime: 22, // W 列
  material: 23,
  surfaceFinish: 24,
  cleaningSpec: 25,
  process: 26,
  size: 27,
  partType: 28,
  comment: 29,
  comment2: 30,
  basePn: 31,
  yj: 32, // AG 列（10-07 从 M 列挪来）
  baseId: 33,
} as const

/** 模板 I–N 供应商槽位的原表头（未占用的槽保留原文） */
export const KK_VENDOR_SLOT_HEADERS = ['Mao', 'HC', 'SKW', 'CL', 'BY', 'JM'] as const

/** 所有供应商价格列（I–N 连续槽位 + AG 列 YJ）：最低价高亮、比价、并入落列都按它 */
export const KK_VENDOR_COLS: readonly { col: number; header: string }[] = [
  ...KK_VENDOR_SLOT_HEADERS.map((header, i) => ({ col: KK_COL.vendorSlotStart + i, header })),
  { col: KK_COL.yj, header: 'YJ' },
]

const VENDOR_COL_SET = new Set(KK_VENDOR_COLS.map((v) => v.col))

/** 该 0 基列号是否为供应商价格列 */
export function isKkVendorCol(col: number): boolean {
  return VENDOR_COL_SET.has(col)
}

export const KK_COL_WIDTHS: readonly number[] = [
  5, 18, 5, 14, 6, 34, 6, 11, 11, 11, 11, 11, 11, 11, 13, 9, 8, 11, 13, 9, 11, 15, 20, 15, 20, 13,
  10, 10, 8, 16, 10, 12, 11, 10,
]

/** 样式常量（argb） */
export const KK_STYLE = {
  headerFill: 'FFD9D9D9',
  minFill: 'FFC6EFCE',
  minFont: 'FF006100',
  pendingFill: 'FFFFEB9C',
  pendingFont: 'FF9C6500',
  borderColor: 'FFBFBFBF',
} as const
